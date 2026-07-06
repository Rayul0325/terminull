/**
 * paneld — the session-host daemon core.
 *
 * paneld owns every panel-spawned PTY so sessions survive panel-server
 * restarts: the panel-server is just another client over a unix socket. The
 * daemon is deliberately tiny and parser-free — nothing tool-specific lives
 * here; it shovels raw bytes between PTYs and attached clients, keeps a
 * bounded per-session ring for reattach replay, and answers a small CTRL
 * vocabulary (see `@terminull/shared` host-protocol).
 *
 * State dir layout (`mode 700`):
 *   host.sock   — unix listener (mode 600)
 *   host-token  — shared auth secret, generated on first boot (mode 600)
 *   host-id     — stable machine-lifetime host id (persisted)
 *
 * Sessions are in-memory only ON PURPOSE: if the daemon dies, its PTY children
 * die with it (kernel closes the masters), so a restarted daemon truthfully
 * reports an empty session list rather than ghosts.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn as ptySpawn, type IPty } from 'node-pty';
import {
  assertSocketPathOk,
  ClientControlSchema,
  FrameDecoder,
  FrameEncoder,
  HOST_PROTO_VERSION,
  type ClientControl,
  type DecodedFrame,
  type HostControl,
  type SessionSummary,
  type SpawnSpec,
} from '@terminull/shared';
import { DEFAULT_RING_BYTES, Ring } from './ring.js';
import { attachArgs, hasSession, resolveTmuxBin } from './tmux.js';

/** Options accepted by the {@link SessionHost} constructor. */
export interface SessionHostOptions {
  /** Directory for the socket, token and host id (created 0700 if absent). */
  stateDir: string;
  /** Per-session output ring capacity in bytes. Defaults to 4 MiB. */
  ringBytes?: number;
}

/** Error codes used in host `error` CTRL frames. */
export const HostErrorCode = {
  Auth: 'AUTH',
  Proto: 'PROTO',
  NotFound: 'NOT_FOUND',
  ReadOnly: 'READ_ONLY',
  Exited: 'EXITED',
  Spawn: 'SPAWN',
  Tmux: 'TMUX',
} as const;

interface Session {
  sid: number;
  cmd: string;
  args: string[];
  label?: string;
  meta?: Record<string, unknown>;
  cols: number;
  rows: number;
  term: IPty;
  pid: number;
  /** False for adopted external tmux sessions (we hold only an attach client). */
  owned: boolean;
  running: boolean;
  ring: Ring;
  /** Connections attached to this session, with their view mode. */
  attachments: Map<Connection, { readOnly: boolean }>;
}

class Connection {
  readonly socket: net.Socket;
  readonly decoder = new FrameDecoder();
  authed = false;

  constructor(socket: net.Socket) {
    this.socket = socket;
  }

  write(frame: Buffer): void {
    if (!this.socket.destroyed && this.socket.writable) this.socket.write(frame);
  }

  ctrl(msg: HostControl): void {
    this.write(FrameEncoder.ctrl(msg));
  }
}

function readOrCreate(file: string, create: () => string, mode: number): string {
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const value = create();
  fs.writeFileSync(file, value + '\n', { mode });
  return value;
}

export class SessionHost {
  readonly stateDir: string;
  readonly socketPath: string;
  /** `<stateDir>/host.pid` — written on successful start, removed on stop. */
  readonly pidPath: string;
  readonly ringBytes: number;

  /** Stable per-machine id, persisted in `<stateDir>/host-id`. */
  hostId = '';
  /** Random per-process id; a client seeing a new bootId knows sessions died. */
  readonly bootId = crypto.randomUUID();

  private token = '';
  private server: net.Server | null = null;
  private readonly connections = new Set<Connection>();
  private readonly sessions = new Map<number, Session>();
  private nextSid = 1;

  constructor(opts: SessionHostOptions) {
    this.stateDir = opts.stateDir;
    this.socketPath = path.join(opts.stateDir, 'host.sock');
    this.pidPath = path.join(opts.stateDir, 'host.pid');
    this.ringBytes = opts.ringBytes ?? DEFAULT_RING_BYTES;
  }

  /** Create state files, bind the unix socket and start accepting clients. */
  async start(): Promise<void> {
    // Guard FIRST, before any filesystem side effect: macOS caps AF_UNIX
    // sun_path at 104 bytes and rejects longer paths at bind(2) with a
    // baffling EINVAL (known live failure). Fail with the coded error and
    // leave no half-created state behind.
    assertSocketPathOk(this.socketPath);
    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.stateDir, 0o700); // mkdirSync mode is ignored for pre-existing dirs
    this.hostId = readOrCreate(
      path.join(this.stateDir, 'host-id'),
      () => crypto.randomUUID(),
      0o644,
    );
    this.token = readOrCreate(
      path.join(this.stateDir, 'host-token'),
      () => crypto.randomBytes(32).toString('hex'),
      0o600,
    );

    // A previous daemon that was SIGKILLed leaves a stale socket file behind;
    // its sessions are dead (PTY masters closed with the process), so binding
    // fresh over it is always the truthful move.
    if (fs.existsSync(this.socketPath)) fs.unlinkSync(this.socketPath);

    this.server = net.createServer((socket) => this.onConnection(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.socketPath, () => resolve());
    });
    fs.chmodSync(this.socketPath, 0o600);
    // Written only AFTER a successful bind so a failed boot never advertises a
    // pid. Consumed by enroll --remove and a future `paneld stop`.
    fs.writeFileSync(this.pidPath, `${process.pid}\n`, { mode: 0o600 });
  }

  /** Graceful shutdown: kill PTY children, drop clients, close the socket. */
  stop(): void {
    for (const s of this.sessions.values()) {
      if (s.running) {
        try {
          // For owned sessions this terminates the child; for adopted tmux
          // sessions it only kills our attach client — the external session
          // survives, which is exactly right (it was never ours).
          s.term.kill('SIGTERM');
        } catch {
          /* already gone */
        }
      }
    }
    for (const conn of this.connections) conn.socket.destroy();
    this.connections.clear();
    this.server?.close();
    this.server = null;
    try {
      fs.unlinkSync(this.socketPath);
    } catch {
      /* never bound or already removed */
    }
    try {
      fs.unlinkSync(this.pidPath);
    } catch {
      /* never written or already removed */
    }
  }

  /** Public summaries of every in-memory session. */
  listSessions(): SessionSummary[] {
    return [...this.sessions.values()].map((s) => this.summarize(s));
  }

  private summarize(s: Session): SessionSummary {
    return {
      sid: s.sid,
      ...(s.label !== undefined ? { label: s.label } : {}),
      cmd: s.cmd,
      args: s.args,
      cols: s.cols,
      rows: s.rows,
      pid: s.pid,
      owned: s.owned,
      running: s.running,
      headSeq: s.ring.headSeq,
      ...(s.meta !== undefined ? { meta: s.meta } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // connection lifecycle
  // -------------------------------------------------------------------------

  private onConnection(socket: net.Socket): void {
    const conn = new Connection(socket);
    this.connections.add(conn);
    socket.on('data', (chunk) => {
      let frames: DecodedFrame[];
      try {
        frames = conn.decoder.push(chunk);
      } catch {
        // Unframeable bytes: this peer is broken or hostile; cut it off.
        socket.destroy();
        return;
      }
      for (const frame of frames) this.onFrame(conn, frame);
    });
    const drop = (): void => {
      this.connections.delete(conn);
      for (const s of this.sessions.values()) s.attachments.delete(conn);
    };
    socket.on('close', drop);
    socket.on('error', () => socket.destroy());
  }

  private error(
    conn: Connection,
    code: string,
    msg: string,
    ids: { reqId?: string; sid?: number } = {},
  ): void {
    conn.ctrl({ t: 'error', code, msg, ...ids });
  }

  private onFrame(conn: Connection, frame: DecodedFrame): void {
    switch (frame.kind) {
      case 'ctrl':
        this.onCtrl(conn, frame.json);
        return;
      case 'in':
        this.onInput(conn, frame.sid, frame.data);
        return;
      case 'out':
        // OUT is host->client only; a client sending it is misbehaving.
        this.error(conn, HostErrorCode.Proto, 'OUT frames are host-to-client only');
        return;
    }
  }

  private onCtrl(conn: Connection, json: unknown): void {
    const parsed = ClientControlSchema.safeParse(json);
    if (!parsed.success) {
      this.error(conn, HostErrorCode.Proto, `invalid control message: ${parsed.error.message}`);
      return;
    }
    const msg = parsed.data;
    if (msg.t === 'hello') {
      this.onHello(conn, msg);
      return;
    }
    if (!conn.authed) {
      this.error(conn, HostErrorCode.Auth, 'hello required before any other message');
      conn.socket.end();
      return;
    }
    switch (msg.t) {
      case 'spawn':
        this.onSpawn(conn, msg);
        return;
      case 'attach':
        this.onAttach(conn, msg);
        return;
      case 'detach':
        this.sessions.get(msg.sid)?.attachments.delete(conn);
        return;
      case 'resize':
        this.onResize(conn, msg);
        return;
      case 'kill':
        this.onKill(conn, msg);
        return;
      case 'list':
        conn.ctrl({ t: 'sessions', reqId: msg.reqId, sessions: this.listSessions() });
        return;
      case 'adoptTmux':
        void this.onAdoptTmux(conn, msg);
        return;
    }
  }

  private onHello(conn: Connection, msg: Extract<ClientControl, { t: 'hello' }>): void {
    // timingSafeEqual demands equal lengths; hash both sides first.
    const a = crypto.createHash('sha256').update(msg.token).digest();
    const b = crypto.createHash('sha256').update(this.token).digest();
    if (!crypto.timingSafeEqual(a, b)) {
      this.error(conn, HostErrorCode.Auth, 'bad token');
      conn.socket.end();
      return;
    }
    conn.authed = true;
    conn.ctrl({
      t: 'helloOk',
      proto: HOST_PROTO_VERSION,
      hostId: this.hostId,
      bootId: this.bootId,
      sessions: this.listSessions(),
    });
  }

  // -------------------------------------------------------------------------
  // session operations
  // -------------------------------------------------------------------------

  /** Register a PTY as a session and wire output fanout + exit broadcast. */
  private register(
    term: IPty,
    info: Pick<Session, 'cmd' | 'args' | 'cols' | 'rows' | 'owned'> &
      Partial<Pick<Session, 'label' | 'meta'>>,
  ): Session {
    const session: Session = {
      sid: this.nextSid++,
      term,
      pid: term.pid,
      running: true,
      ring: new Ring(this.ringBytes),
      attachments: new Map(),
      ...info,
    };
    this.sessions.set(session.sid, session);

    term.onData((data: string | Buffer) => {
      // With `encoding: null` node-pty emits Buffers at runtime even though
      // its typings say string; normalise defensively.
      const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
      const seq = session.ring.headSeq; // seq of this chunk's first byte
      session.ring.append(bytes);
      const frame = FrameEncoder.out(session.sid, BigInt(seq), bytes);
      for (const attached of session.attachments.keys()) attached.write(frame);
    });

    term.onExit(({ exitCode, signal }) => {
      session.running = false;
      const exit: HostControl = {
        t: 'exit',
        sid: session.sid,
        code: exitCode ?? null,
        signal: signal ?? null,
      };
      // Every authenticated client learns about exits (list-watchers included).
      for (const conn of this.connections) {
        if (conn.authed) conn.ctrl(exit);
      }
    });

    return session;
  }

  private onSpawn(conn: Connection, msg: Extract<ClientControl, { t: 'spawn' }>): void {
    const spec: SpawnSpec = msg.spec;
    let term: IPty;
    try {
      term = ptySpawn(spec.cmd, spec.args, {
        name: 'xterm-256color',
        cols: spec.cols,
        rows: spec.rows,
        cwd: spec.cwd,
        env: { ...process.env, ...spec.env },
        encoding: null,
      });
    } catch (e) {
      this.error(conn, HostErrorCode.Spawn, e instanceof Error ? e.message : String(e), {
        reqId: msg.reqId,
      });
      return;
    }
    const session = this.register(term, {
      cmd: spec.cmd,
      args: spec.args,
      cols: spec.cols,
      rows: spec.rows,
      owned: true,
      ...(spec.label !== undefined ? { label: spec.label } : {}),
      ...(spec.meta !== undefined ? { meta: spec.meta } : {}),
    });
    // The spawner is implicitly attached read-write: its OUT starts flowing
    // right after `spawned` without a separate attach round-trip.
    session.attachments.set(conn, { readOnly: false });
    conn.ctrl({ t: 'spawned', reqId: msg.reqId, sid: session.sid, pid: session.pid });
  }

  private onAttach(conn: Connection, msg: Extract<ClientControl, { t: 'attach' }>): void {
    const session = this.sessions.get(msg.sid);
    if (!session) {
      this.error(conn, HostErrorCode.NotFound, `no session ${msg.sid}`, {
        reqId: msg.reqId,
        sid: msg.sid,
      });
      return;
    }
    const replay = session.ring.replayFrom(msg.sinceSeq ?? 0);
    session.attachments.set(conn, { readOnly: msg.readOnly ?? false });
    conn.ctrl({
      t: 'attached',
      reqId: msg.reqId,
      sid: session.sid,
      fromSeq: replay.fromSeq,
      headSeq: replay.headSeq,
      gap: replay.gap,
    });
    // Replay retained scrollback as ordinary OUT frames. Registration and
    // replay happen in the same tick, so live onData fanout (queued behind us
    // on the event loop) can never interleave into the replayed range.
    let seq = replay.fromSeq;
    for (const chunk of replay.chunks) {
      conn.write(FrameEncoder.out(session.sid, BigInt(seq), chunk));
      seq += chunk.length;
    }
  }

  private onResize(conn: Connection, msg: Extract<ClientControl, { t: 'resize' }>): void {
    const session = this.sessions.get(msg.sid);
    if (!session) {
      this.error(conn, HostErrorCode.NotFound, `no session ${msg.sid}`, { sid: msg.sid });
      return;
    }
    const attachment = session.attachments.get(conn);
    if (!attachment || attachment.readOnly) {
      // Latest-active-WRITER wins: read-only viewers never drive geometry.
      this.error(conn, HostErrorCode.ReadOnly, 'read-only attachments may not resize', {
        sid: msg.sid,
      });
      return;
    }
    if (!session.running) {
      this.error(conn, HostErrorCode.Exited, `session ${msg.sid} has exited`, { sid: msg.sid });
      return;
    }
    try {
      session.term.resize(msg.cols, msg.rows);
      session.cols = msg.cols;
      session.rows = msg.rows;
    } catch (e) {
      this.error(conn, HostErrorCode.Spawn, e instanceof Error ? e.message : String(e), {
        sid: msg.sid,
      });
    }
  }

  private onKill(conn: Connection, msg: Extract<ClientControl, { t: 'kill' }>): void {
    const session = this.sessions.get(msg.sid);
    if (!session) {
      this.error(conn, HostErrorCode.NotFound, `no session ${msg.sid}`, { sid: msg.sid });
      return;
    }
    if (!session.running) {
      this.error(conn, HostErrorCode.Exited, `session ${msg.sid} has already exited`, {
        sid: msg.sid,
      });
      return;
    }
    try {
      session.term.kill(msg.signal ?? 'SIGTERM');
    } catch (e) {
      this.error(conn, HostErrorCode.Spawn, e instanceof Error ? e.message : String(e), {
        sid: msg.sid,
      });
    }
  }

  private onInput(conn: Connection, sid: number, data: Buffer): void {
    const session = this.sessions.get(sid);
    if (!session) {
      this.error(conn, HostErrorCode.NotFound, `no session ${sid}`, { sid });
      return;
    }
    const attachment = session.attachments.get(conn);
    if (!attachment) {
      this.error(conn, HostErrorCode.NotFound, `not attached to session ${sid}`, { sid });
      return;
    }
    if (attachment.readOnly) {
      this.error(conn, HostErrorCode.ReadOnly, 'read-only attachments may not write', { sid });
      return;
    }
    if (!session.running) {
      this.error(conn, HostErrorCode.Exited, `session ${sid} has exited`, { sid });
      return;
    }
    session.term.write(data);
  }

  private async onAdoptTmux(
    conn: Connection,
    msg: Extract<ClientControl, { t: 'adoptTmux' }>,
  ): Promise<void> {
    const bin = resolveTmuxBin();
    if (!bin) {
      this.error(conn, HostErrorCode.Tmux, 'tmux binary not found', { reqId: msg.reqId });
      return;
    }
    if (!(await hasSession(bin, msg.target))) {
      this.error(conn, HostErrorCode.Tmux, `no tmux session "${msg.target}"`, {
        reqId: msg.reqId,
      });
      return;
    }
    let term: IPty;
    try {
      term = ptySpawn(bin, attachArgs(msg.target), {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: this.stateDir,
        env: { ...process.env },
        encoding: null,
      });
    } catch (e) {
      this.error(conn, HostErrorCode.Tmux, e instanceof Error ? e.message : String(e), {
        reqId: msg.reqId,
      });
      return;
    }
    const session = this.register(term, {
      cmd: bin,
      args: attachArgs(msg.target),
      cols: 80,
      rows: 24,
      owned: false, // the tmux session belongs to an external server
      label: `tmux:${msg.target}`,
      meta: { tmuxTarget: msg.target },
    });
    session.attachments.set(conn, { readOnly: false });
    conn.ctrl({ t: 'spawned', reqId: msg.reqId, sid: session.sid, pid: session.pid });
  }
}
