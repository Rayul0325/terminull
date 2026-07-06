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
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FrameDecoder,
  FrameEncoder,
  HOST_PROTO_VERSION,
  HostControlSchema,
  type HostControl,
  type SessionSummary,
  type SpawnSpec,
} from '@terminull/shared';

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

type CtrlListener = (msg: HostControl) => void;
type OutListener = (sid: number, seq: bigint, data: Buffer) => void;

/**
 * One framed, hello-authenticated connection to the daemon. Both the control
 * connection and per-PTY attachments are built on this.
 */
class HostConnection {
  private readonly pending = new Map<
    string,
    { resolve: (msg: HostControl) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >();
  private readonly ctrlListeners = new Set<CtrlListener>();
  private readonly outListeners = new Set<OutListener>();
  private readonly closeListeners = new Set<() => void>();
  private closed = false;

  private constructor(
    private readonly socket: net.Socket,
    private readonly requestTimeoutMs: number,
    readonly helloOk: Extract<HostControl, { t: 'helloOk' }>,
  ) {
    const decoder = new FrameDecoder();
    socket.on('data', (chunk: Buffer) => {
      let frames;
      try {
        frames = decoder.push(chunk);
      } catch {
        socket.destroy();
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
    socket.on('close', () => {
      this.closed = true;
      const err = new Error('host connection closed');
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
      for (const fn of this.closeListeners) fn();
    });
    socket.on('error', () => socket.destroy());
  }

  /** Connect + hello. Rejects on refused socket, bad token, or timeout. */
  static open(
    socketPath: string,
    token: string,
    opts: { requestTimeoutMs?: number } = {},
  ): Promise<HostConnection> {
    const timeoutMs = opts.requestTimeoutMs ?? 10_000;
    return new Promise((resolve, reject) => {
      const socket = net.connect(socketPath);
      const decoder = new FrameDecoder();
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('timed out waiting for helloOk'));
      }, timeoutMs);
      const bail = (err: Error): void => {
        clearTimeout(timer);
        socket.destroy();
        reject(err);
      };
      socket.once('error', bail);
      socket.on('connect', () => {
        socket.write(FrameEncoder.ctrl({ t: 'hello', proto: HOST_PROTO_VERSION, token }));
      });
      const onData = (chunk: Buffer): void => {
        let frames;
        try {
          frames = decoder.push(chunk);
        } catch (e) {
          bail(e instanceof Error ? e : new Error(String(e)));
          return;
        }
        for (const frame of frames) {
          if (frame.kind !== 'ctrl') continue;
          const parsed = HostControlSchema.safeParse(frame.json);
          if (!parsed.success) continue;
          const msg = parsed.data;
          clearTimeout(timer);
          socket.removeListener('data', onData);
          socket.removeListener('error', bail);
          if (msg.t === 'helloOk') {
            resolve(new HostConnection(socket, timeoutMs, msg));
          } else {
            const detail = msg.t === 'error' ? `${msg.code}: ${msg.msg}` : msg.t;
            socket.destroy();
            reject(new Error(`hello rejected (${detail})`));
          }
          return;
        }
      };
      socket.on('data', onData);
    });
  }

  private onCtrl(jsonValue: unknown): void {
    const parsed = HostControlSchema.safeParse(jsonValue);
    if (!parsed.success) return; // unknown ctrl — forward-compat, ignore
    const msg = parsed.data;
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

  /** Send a reqId-bearing CTRL and await its reply (or error frame). */
  request(msg: Parameters<typeof FrameEncoder.ctrl>[0] & { reqId: string }): Promise<HostControl> {
    if (this.closed) return Promise.reject(new HostUnavailableError());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(msg.reqId);
        reject(new Error(`host request '${msg.t}' timed out`));
      }, this.requestTimeoutMs);
      this.pending.set(msg.reqId, { resolve, reject, timer });
      this.socket.write(FrameEncoder.ctrl(msg));
    });
  }

  /** Fire-and-forget CTRL (detach/resize/kill). */
  send(msg: Parameters<typeof FrameEncoder.ctrl>[0]): void {
    if (this.closed) throw new HostUnavailableError();
    this.socket.write(FrameEncoder.ctrl(msg));
  }

  /** Raw input bytes for a session (IN frame). */
  input(sid: number, data: Buffer): void {
    if (this.closed) throw new HostUnavailableError();
    this.socket.write(FrameEncoder.input(sid, data));
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
    this.socket.destroy();
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

    const outListeners = new Set<(data: Buffer) => void>();
    const exitListeners = new Set<(exit: HostExitInfo) => void>();
    conn.onOut((outSid, _seq, data) => {
      if (outSid === sid) for (const fn of outListeners) fn(data);
    });
    conn.onCtrlMessage((msg) => {
      if (msg.t === 'exit' && msg.sid === sid) {
        for (const fn of exitListeners)
          fn({ sid: msg.sid, code: msg.code, signal: msg.signal ?? null });
      }
    });

    return {
      sid,
      fromSeq: attached.fromSeq,
      headSeq: attached.headSeq,
      gap: attached.gap,
      readOnly,
      write: (data) => conn.input(sid, data),
      resize: (cols, rows) => conn.send({ t: 'resize', sid, cols, rows }),
      onOut: (fn) => outListeners.add(fn),
      onExit: (fn) => exitListeners.add(fn),
      onClose: (fn) => conn.onClose(fn),
      close: () => conn.close(),
    };
  }
}
