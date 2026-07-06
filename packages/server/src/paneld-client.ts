/**
 * paneld client — the panel server's connection to the session-host daemon.
 *
 * The daemon owns every PTY so sessions survive panel-server restarts; this
 * client is "just another client" over the unix socket, speaking the shared
 * host-protocol. It maintains ONE long-lived control connection (spawn / list /
 * kill / directive input) with reconnect-and-backoff, and opens a DEDICATED
 * connection per PTY bridge (`openAttachment`) so replay, read-only mode and
 * resize rights stay isolated per WebSocket viewer.
 *
 * Honesty contract: `connected`/`bootId` reflect the real socket state; the
 * caller is told `resumed=false` whenever the daemon rebooted (bootId changed),
 * which means every previously known session is dead — never ghosted.
 */
import { spawn as spawnChild } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AgentHostControlSchema,
  FrameDecoder,
  FrameEncoder,
  HOST_PROTO_VERSION,
  HostControlSchema,
  type AgentClientControl,
  type AgentHostControl,
  type HostControl,
  type SessionSummary,
  type SpawnSpec,
} from '@terminull/shared';
import { UnixSocketTransport, type FrameStream } from './transport.js';

/** Snapshot handed to `onUp` after every successful hello. */
export interface HostUpInfo {
  hostId: string;
  bootId: string;
  /** True when this is the same daemon process as the previous connection. */
  resumed: boolean;
  sessions: SessionSummary[];
}

/** A session exit broadcast from the daemon. */
export interface HostExitInfo {
  sid: number;
  code: number | null;
  signal: number | null;
}

/** Options for {@link PaneldClient}. */
export interface PaneldClientOptions {
  /** paneld state dir (host.sock / host-token / host-id). */
  hostStateDir: string;
  /** Spawn a detached paneld child when the socket is dead (default true). */
  spawnIfDead?: boolean;
  /** Path to the paneld bin script (default: resolved from the workspace). */
  paneldBin?: string;
  /** Per-request timeout (default 10s). */
  requestTimeoutMs?: number;
  backoffMinMs?: number;
  backoffMaxMs?: number;
  onUp?: (info: HostUpInfo) => void;
  onDown?: () => void;
  onExit?: (exit: HostExitInfo) => void;
}

/** Thrown when an operation needs the control connection and it is down. */
export class HostUnavailableError extends Error {
  readonly code = 'host_unavailable';
  constructor() {
    super('session host is not connected');
    this.name = 'HostUnavailableError';
  }
}

/** Thrown when the daemon answers a request with an error frame. */
export class HostRequestError extends Error {
  constructor(
    /** Host error code (e.g. 'SPAWN', 'NOT_FOUND'). */
    readonly hostCode: string,
    readonly hostMessage: string,
  ) {
    super(`${hostCode}: ${hostMessage}`);
    this.name = 'HostRequestError';
  }
}

/** Resolve the packaged paneld bin next to `@terminull/session-host`'s entry. */
export function defaultPaneldBin(): string {
  // The package ships an ESM-only exports map, so try ESM resolution first;
  // createRequire is the fallback for runtimes without import.meta.resolve.
  let entry: string;
  try {
    entry = fileURLToPath(import.meta.resolve('@terminull/session-host'));
  } catch {
    const require = createRequire(import.meta.url);
    entry = require.resolve('@terminull/session-host');
  }
  return path.join(path.dirname(entry), 'bin.js');
}

type CtrlListener = (msg: AgentHostControl) => void;
type OutListener = (sid: number, seq: bigint, data: Buffer) => void;

/** Options accepted by {@link HostConnection.open}/{@link HostConnection.openOnStream}. */
export interface HostConnectionOptions {
  requestTimeoutMs?: number;
  /**
   * Parse inbound CTRL with the AGENT vocabulary (paneld's + `collected`).
   * Machine control links set this; local paneld links keep the plain schema
   * (which rejects `collected` — paneld never speaks it).
   */
  agent?: boolean;
}

/**
 * Encode an outbound CTRL. `collect` is not in paneld's ClientControl union,
 * but the wire encoding (JSON in a CTRL frame) is identical — the assertion
 * only widens the compile-time view for agent links.
 */
function encodeCtrl(msg: AgentClientControl): Buffer {
  return FrameEncoder.ctrl(msg as Parameters<typeof FrameEncoder.ctrl>[0]);
}

/**
 * One framed, hello-authenticated connection to a session-host daemon over any
 * {@link FrameStream} (local unix socket or a remote stdio relay). The control
 * connection, per-PTY attachments and machine links are all built on this.
 */
export class HostConnection {
  private readonly pending = new Map<
    string,
    {
      resolve: (msg: AgentHostControl) => void;
      reject: (err: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private readonly ctrlListeners = new Set<CtrlListener>();
  private readonly outListeners = new Set<OutListener>();
  private readonly closeListeners = new Set<() => void>();
  private readonly parseCtrl: (json: unknown) => AgentHostControl | null;
  private closed = false;
  /** Assigned by {@link openOnStream} before the connection is handed out. */
  helloOk!: Extract<HostControl, { t: 'helloOk' }>;

  private constructor(
    private readonly stream: FrameStream,
    private readonly requestTimeoutMs: number,
    agent: boolean,
  ) {
    this.parseCtrl = (json) => {
      const parsed = agent
        ? AgentHostControlSchema.safeParse(json)
        : HostControlSchema.safeParse(json);
      return parsed.success ? parsed.data : null;
    };
    const decoder = new FrameDecoder();
    stream.onData((chunk: Buffer) => {
      let frames;
      try {
        frames = decoder.push(chunk);
      } catch {
        stream.close();
        return;
      }
      for (const frame of frames) {
        if (frame.kind === 'out') {
          for (const fn of this.outListeners) fn(frame.sid, frame.seq, frame.data);
        } else if (frame.kind === 'ctrl') {
          this.onCtrl(frame.json);
        }
      }
    });
    stream.onClose(() => {
      this.closed = true;
      const err = new Error('host connection closed');
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
      for (const fn of this.closeListeners) fn();
    });
  }

  /**
   * Hello-handshake over an already-connected stream (the M8 seam: machine
   * links hand in a stdio-relay stream here). Rejects on a refused hello, a
   * stream that closes mid-handshake, or the timeout.
   */
  static openOnStream(
    stream: FrameStream,
    token: string,
    opts: HostConnectionOptions = {},
  ): Promise<HostConnection> {
    const timeoutMs = opts.requestTimeoutMs ?? 10_000;
    const conn = new HostConnection(stream, timeoutMs, opts.agent ?? false);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.close();
        reject(new Error('timed out waiting for helloOk'));
      }, timeoutMs);
      const onFirstCtrl: CtrlListener = (msg) => {
        conn.ctrlListeners.delete(onFirstCtrl);
        clearTimeout(timer);
        if (msg.t === 'helloOk') {
          conn.helloOk = msg;
          resolve(conn);
          return;
        }
        const detail = msg.t === 'error' ? `${msg.code}: ${msg.msg}` : msg.t;
        conn.close();
        reject(new Error(`hello rejected (${detail})`));
      };
      conn.ctrlListeners.add(onFirstCtrl);
      conn.onClose(() => {
        clearTimeout(timer);
        reject(new Error('host connection closed during hello'));
      });
      stream.write(encodeCtrl({ t: 'hello', proto: HOST_PROTO_VERSION, token }));
    });
  }

  /** Connect + hello over a local unix socket (path length validated first). */
  static async open(
    socketPath: string,
    token: string,
    opts: HostConnectionOptions = {},
  ): Promise<HostConnection> {
    const stream = await new UnixSocketTransport(socketPath).connect();
    return HostConnection.openOnStream(stream, token, opts);
  }

  private onCtrl(jsonValue: unknown): void {
    const msg = this.parseCtrl(jsonValue);
    if (msg === null) return; // unknown ctrl — forward-compat, ignore
    const reqId = 'reqId' in msg ? msg.reqId : undefined;
    if (reqId !== undefined) {
      const waiter = this.pending.get(reqId);
      if (waiter) {
        this.pending.delete(reqId);
        clearTimeout(waiter.timer);
        if (msg.t === 'error') waiter.reject(new HostRequestError(msg.code, msg.msg));
        else waiter.resolve(msg);
        return;
      }
    }
    for (const fn of this.ctrlListeners) fn(msg);
  }

  /**
   * Send a reqId-bearing CTRL and await its reply (or error frame).
   * `timeoutMs` overrides the connection default (e.g. the collect budget).
   */
  request(
    msg: AgentClientControl & { reqId: string },
    timeoutMs?: number,
  ): Promise<AgentHostControl> {
    if (this.closed) return Promise.reject(new HostUnavailableError());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(msg.reqId);
        reject(new Error(`host request '${msg.t}' timed out`));
      }, timeoutMs ?? this.requestTimeoutMs);
      this.pending.set(msg.reqId, { resolve, reject, timer });
      this.stream.write(encodeCtrl(msg));
    });
  }

  /** Fire-and-forget CTRL (detach/resize/kill). */
  send(msg: AgentClientControl): void {
    if (this.closed) throw new HostUnavailableError();
    this.stream.write(encodeCtrl(msg));
  }

  /** Raw input bytes for a session (IN frame). */
  input(sid: number, data: Buffer): void {
    if (this.closed) throw new HostUnavailableError();
    this.stream.write(FrameEncoder.input(sid, data));
  }

  /** OS pid of the stream's backing child, when it is a process stream. */
  get childPid(): number | null {
    return this.stream.childPid ?? null;
  }

  onCtrlMessage(fn: CtrlListener): void {
    this.ctrlListeners.add(fn);
  }

  onOut(fn: OutListener): void {
    this.outListeners.add(fn);
  }

  onClose(fn: () => void): void {
    if (this.closed) fn();
    else this.closeListeners.add(fn);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    this.stream.close();
  }
}

/** A dedicated per-viewer PTY attachment (its own daemon connection). */
export interface PtyAttachment {
  sid: number;
  /** Replay metadata from the daemon's `attached` reply. */
  fromSeq: number;
  headSeq: number;
  gap: boolean;
  readOnly: boolean;
  write(data: Buffer): void;
  resize(cols: number, rows: number): void;
  onOut(fn: (data: Buffer) => void): void;
  onExit(fn: (exit: HostExitInfo) => void): void;
  onClose(fn: () => void): void;
  close(): void;
}

export class PaneldClient {
  readonly hostStateDir: string;
  readonly socketPath: string;
  private readonly spawnIfDead: boolean;
  /** Resolved lazily — only a real spawn attempt needs the bin path. */
  private paneldBin: string | undefined;
  private readonly requestTimeoutMs: number;
  private readonly backoffMinMs: number;
  private readonly backoffMaxMs: number;
  private readonly onUpCb: ((info: HostUpInfo) => void) | undefined;
  private readonly onDownCb: (() => void) | undefined;
  private readonly onExitCb: ((exit: HostExitInfo) => void) | undefined;

  private conn: HostConnection | null = null;
  private lastBootId: string | null = null;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private backoffMs: number;
  private spawnAttempted = false;
  /** sids the CONTROL connection is currently attached to (for input). */
  private readonly attachedSids = new Set<number>();
  private readonly upWaiters = new Set<() => void>();

  constructor(private readonly opts: PaneldClientOptions) {
    this.hostStateDir = opts.hostStateDir;
    this.socketPath = path.join(opts.hostStateDir, 'host.sock');
    this.spawnIfDead = opts.spawnIfDead ?? true;
    this.paneldBin = opts.paneldBin;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 10_000;
    this.backoffMinMs = opts.backoffMinMs ?? 250;
    this.backoffMaxMs = opts.backoffMaxMs ?? 4000;
    this.backoffMs = this.backoffMinMs;
    this.onUpCb = opts.onUp;
    this.onDownCb = opts.onDown;
    this.onExitCb = opts.onExit;
  }

  get connected(): boolean {
    return this.conn !== null && !this.conn.isClosed;
  }

  get bootId(): string | null {
    return this.lastBootId;
  }

  /**
   * Begin connecting. Resolves after the FIRST attempt (up or not) so a dead
   * daemon degrades the server instead of blocking boot; retries continue in
   * the background until {@link stop}.
   */
  async start(): Promise<void> {
    await this.tryConnect();
  }

  /** Wait until the control connection is up (test/CLI convenience). */
  waitUp(timeoutMs = 10_000): Promise<void> {
    if (this.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.upWaiters.delete(onUp);
        reject(new Error('timed out waiting for session host'));
      }, timeoutMs);
      const onUp = (): void => {
        clearTimeout(timer);
        resolve();
      };
      this.upWaiters.add(onUp);
    });
  }

  /** Stop reconnecting and close the control connection (daemon keeps running). */
  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.conn?.close();
    this.conn = null;
  }

  private readToken(): string | null {
    try {
      return fs.readFileSync(path.join(this.hostStateDir, 'host-token'), 'utf8').trim();
    } catch {
      return null;
    }
  }

  private maybeSpawnDaemon(): void {
    if (!this.spawnIfDead || this.spawnAttempted) return;
    this.spawnAttempted = true;
    try {
      this.paneldBin ??= defaultPaneldBin();
      // Route the daemon's output to a log file: a boot failure (e.g. the
      // AF_UNIX 104-byte socket-path cap on macOS) must leave a breadcrumb,
      // not die silently into stdio:'ignore'.
      fs.mkdirSync(this.hostStateDir, { recursive: true, mode: 0o700 });
      const log = fs.openSync(path.join(this.hostStateDir, 'paneld.log'), 'a');
      const child = spawnChild(
        process.execPath,
        [this.paneldBin, 'start', '--state-dir', this.hostStateDir],
        { detached: true, stdio: ['ignore', log, log] },
      );
      child.unref();
      fs.closeSync(log);
    } catch {
      // Spawn failure is not fatal: we keep retrying the socket and the server
      // stays up in degraded mode (host.connected=false is the honest state).
    }
  }

  private async tryConnect(): Promise<void> {
    if (this.stopped || this.connected) return;
    const token = this.readToken();
    if (token === null) {
      this.maybeSpawnDaemon();
      this.scheduleReconnect();
      return;
    }
    let conn: HostConnection;
    try {
      conn = await HostConnection.open(this.socketPath, token, {
        requestTimeoutMs: this.requestTimeoutMs,
      });
    } catch {
      this.maybeSpawnDaemon();
      this.scheduleReconnect();
      return;
    }
    this.conn = conn;
    this.backoffMs = this.backoffMinMs;
    this.spawnAttempted = false; // a future death may spawn again
    this.attachedSids.clear();
    const hello = conn.helloOk;
    const resumed = this.lastBootId !== null && this.lastBootId === hello.bootId;
    this.lastBootId = hello.bootId;

    conn.onCtrlMessage((msg) => {
      if (msg.t === 'exit') {
        this.attachedSids.delete(msg.sid);
        this.onExitCb?.({ sid: msg.sid, code: msg.code, signal: msg.signal ?? null });
      }
    });
    conn.onClose(() => {
      if (this.conn === conn) {
        this.conn = null;
        this.attachedSids.clear();
        this.onDownCb?.();
        this.scheduleReconnect();
      }
    });

    this.onUpCb?.({
      hostId: hello.hostId,
      bootId: hello.bootId,
      resumed,
      sessions: hello.sessions,
    });
    for (const w of [...this.upWaiters]) {
      this.upWaiters.delete(w);
      w();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.backoffMaxMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.tryConnect();
    }, delay);
  }

  private control(): HostConnection {
    if (!this.conn || this.conn.isClosed) throw new HostUnavailableError();
    return this.conn;
  }

  /** Spawn a PTY session. The control connection is auto-attached read-write. */
  async spawn(spec: SpawnSpec): Promise<{ sid: number; pid: number }> {
    const reply = await this.control().request({
      t: 'spawn',
      reqId: crypto.randomUUID(),
      spec,
    });
    if (reply.t !== 'spawned') throw new Error(`unexpected reply ${reply.t}`);
    this.attachedSids.add(reply.sid);
    return { sid: reply.sid, pid: reply.pid };
  }

  /** List the daemon's sessions. */
  async list(): Promise<SessionSummary[]> {
    const reply = await this.control().request({ t: 'list', reqId: crypto.randomUUID() });
    if (reply.t !== 'sessions') throw new Error(`unexpected reply ${reply.t}`);
    return reply.sessions;
  }

  /** Attach the control connection (read-write) once, for directive input. */
  async ensureAttached(sid: number): Promise<void> {
    if (this.attachedSids.has(sid)) return;
    const reply = await this.control().request({
      t: 'attach',
      reqId: crypto.randomUUID(),
      sid,
      // Directive input needs write access, not scrollback: replay from head.
      sinceSeq: Number.MAX_SAFE_INTEGER,
    });
    if (reply.t !== 'attached') throw new Error(`unexpected reply ${reply.t}`);
    this.attachedSids.add(sid);
  }

  /** Write input bytes to a session (must be {@link ensureAttached} first). */
  input(sid: number, data: Buffer): void {
    this.control().input(sid, data);
  }

  /** Signal a session (SIGTERM by default). Fire-and-forget. */
  kill(sid: number, signal?: string): void {
    this.control().send({ t: 'kill', sid, ...(signal !== undefined ? { signal } : {}) });
  }

  /**
   * Open a DEDICATED connection attached to `sid` for a PTY bridge. Isolated
   * from the control connection so per-viewer readOnly/replay/resize semantics
   * are enforced by the daemon itself, per connection.
   */
  async openAttachment(
    sid: number,
    opts: { sinceSeq?: number; readOnly?: boolean } = {},
  ): Promise<PtyAttachment> {
    const token = this.readToken();
    if (token === null) throw new HostUnavailableError();
    const conn = await HostConnection.open(this.socketPath, token, {
      requestTimeoutMs: this.requestTimeoutMs,
    });
    const readOnly = opts.readOnly ?? false;
    // The daemon streams the ring replay in the same tick as the `attached`
    // reply, so on a delayed reader both land in ONE stream chunk and the
    // replay frames are dispatched before this function resumes from the
    // await below (macos-14 CI ring-replay flake, 2026-07-06). Register the
    // conn-level sinks BEFORE the attach request goes out and hold early
    // frames in a backlog until the consumer registers its handler (every
    // consumer does so synchronously after openAttachment resolves).
    const outListeners = new Set<(data: Buffer) => void>();
    const exitListeners = new Set<(exit: HostExitInfo) => void>();
    let outBacklog: Buffer[] | null = [];
    let exitBacklog: HostExitInfo[] | null = [];
    conn.onOut((outSid, _seq, data) => {
      if (outSid !== sid) return;
      if (outBacklog !== null) outBacklog.push(data);
      else for (const fn of outListeners) fn(data);
    });
    conn.onCtrlMessage((msg) => {
      if (msg.t !== 'exit' || msg.sid !== sid) return;
      const exit: HostExitInfo = { sid: msg.sid, code: msg.code, signal: msg.signal ?? null };
      if (exitBacklog !== null) exitBacklog.push(exit);
      else for (const fn of exitListeners) fn(exit);
    });
    let attached: Extract<HostControl, { t: 'attached' }>;
    try {
      const reply = await conn.request({
        t: 'attach',
        reqId: crypto.randomUUID(),
        sid,
        sinceSeq: opts.sinceSeq ?? 0,
        readOnly,
      });
      if (reply.t !== 'attached') throw new Error(`unexpected reply ${reply.t}`);
      attached = reply;
    } catch (e) {
      conn.close();
      throw e;
    }

    return {
      sid,
      fromSeq: attached.fromSeq,
      headSeq: attached.headSeq,
      gap: attached.gap,
      readOnly,
      write: (data) => conn.input(sid, data),
      resize: (cols, rows) => conn.send({ t: 'resize', sid, cols, rows }),
      onOut: (fn) => {
        outListeners.add(fn);
        if (outBacklog !== null) {
          const backlog = outBacklog;
          outBacklog = null;
          for (const data of backlog) fn(data);
        }
      },
      onExit: (fn) => {
        exitListeners.add(fn);
        if (exitBacklog !== null) {
          const backlog = exitBacklog;
          exitBacklog = null;
          for (const exit of backlog) fn(exit);
        }
      },
      onClose: (fn) => conn.onClose(fn),
      close: () => conn.close(),
    };
  }
}
