/**
 * Machine manager — per-machine remote paneld links over frame transports (M8).
 *
 * FSM per machine: connecting → connected → stale{lastSeenAt} → connected …
 * (disabled short-circuits everything). One CONTROL stream per machine carries
 * spawn/list/kill/input + the relay-terminated `collect`; each PTY attachment
 * dials its own fresh stream via the same transport. Control-link death ⇒ the
 * machine goes stale, its open attachments are closed (viewers get an honest
 * 1011), and redial backoff starts; the LOCAL machine is untouched by design.
 *
 * Honesty rules (contract §0/§3): `stale` requires `lastSeenAt` (last VERIFIED
 * contact) — a machine that stops responding is never shown connected and
 * never silently dropped; a machine never yet reached stays `connecting`.
 * Liveness is owned by the heartbeat + control-link close; a failed `collect`
 * alone never marks a machine stale.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  LOCAL_MACHINE_ID,
  MACHINES_FILE,
  MachinesFileSchema,
  type Collected,
  type MachineConfig,
  type MachineConnectionState,
  type MachineStateCode,
  type MachineStateDto,
  type MachineStatePayload,
  type SessionSummary,
  type SpawnSpec,
} from '@terminull/shared';
import {
  HostConnection,
  HostUnavailableError,
  type HostExitInfo,
  type HostUpInfo,
  type PtyAttachment,
} from './paneld-client.js';
import { TransportDialError, transportForSpec, type FrameStream } from './transport.js';

/** Thrown when a route names a machine id that is not registered. */
export class UnknownMachineError extends Error {
  readonly code = 'unknown_machine';
  constructor(readonly machineId: string) {
    super(`unknown machine '${machineId}'`);
    this.name = 'UnknownMachineError';
  }
}

/** Thrown when a remote operation needs a machine link that is not connected. */
export class MachineUnavailableError extends Error {
  readonly code = 'machine_unavailable';
  constructor(
    readonly machineId: string,
    readonly state: MachineStateDto['state'],
  ) {
    super(`machine '${machineId}' is ${state}`);
    this.name = 'MachineUnavailableError';
  }
}

/** Options for {@link MachineManager}. All timings are test-injectable. */
export interface MachineManagerOptions {
  machines: MachineConfig[];
  /** Liveness probe interval on the control link (`list` ping). Default 10s. */
  heartbeatMs?: number;
  /** Per-request timeout (a missed heartbeat reply marks the link dead). */
  requestTimeoutMs?: number;
  backoffMinMs?: number;
  backoffMaxMs?: number;
  /** Remote collect budget; a timeout is a per-machine collect failure. */
  collectTimeoutMs?: number;
  /** Called on EVERY FSM transition — the server appends `machine.state`. */
  onState: (payload: MachineStatePayload) => void;
  /** Relay stderr diagnostics (server logs them, masked). */
  onStderr?: (machineId: string, chunk: string) => void;
  /**
   * Called after every successful hello on a machine's control link, with the
   * remote daemon's advertised sessions — the server reconciles its registry
   * per machine here (`resumed=false` ⇔ the remote daemon rebooted).
   */
  onUp?: (machineId: string, info: HostUpInfo) => void;
  /** A session exit broadcast on a machine's control link. */
  onExit?: (machineId: string, exit: HostExitInfo) => void;
}

/**
 * Read `<stateDir>/machines.json`. Absent file = no remote machines (a valid,
 * common state). A corrupt/invalid file throws — a half-read machine registry
 * must never be silently dropped.
 */
export function loadMachinesFile(stateDir: string): MachineConfig[] {
  const file = path.join(stateDir, MACHINES_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const parsed = MachinesFileSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(
      `invalid ${MACHINES_FILE}: ${parsed.error.issues[0]?.message ?? 'parse_error'}`,
    );
  }
  return parsed.data.machines;
}

/** Atomically write `<stateDir>/machines.json` (write-then-rename, 0600). */
export function saveMachinesFile(stateDir: string, machines: MachineConfig[]): void {
  const file = path.join(stateDir, MACHINES_FILE);
  const body = JSON.stringify({ version: 1, machines }, null, 2) + '\n';
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Per-machine runtime: config + FSM state + the live control link. */
interface MachineRuntime {
  cfg: MachineConfig;
  state: MachineConnectionState;
  lastSeenAt: number | null;
  hostId?: string;
  bootId?: string;
  /** Last seen remote bootId across reconnects (resumed detection). */
  lastBootId?: string;
  attempts: number;
  lastError?: string;
  conn: HostConnection | null;
  /** The control link's underlying stream (childPid test hook). */
  stream: FrameStream | null;
  dialing: boolean;
  redialTimer: NodeJS.Timeout | null;
  heartbeatTimer: NodeJS.Timeout | null;
  heartbeatInFlight: boolean;
  backoffMs: number;
  /** sids the CONTROL link is attached to (directive input). */
  attachedSids: Set<number>;
  /** Open per-viewer attachments (closed when the machine goes stale). */
  attachments: Set<PtyAttachment>;
  /** Bumped on reload/teardown so in-flight dials of an old config self-drop. */
  gen: number;
}

export class MachineManager {
  private readonly runtimes = new Map<string, MachineRuntime>();
  protected readonly opts: MachineManagerOptions;
  private readonly heartbeatMs: number;
  private readonly requestTimeoutMs: number;
  private readonly backoffMinMs: number;
  private readonly backoffMaxMs: number;
  private readonly collectTimeoutMs: number;
  private started = false;
  private stopped = false;

  constructor(opts: MachineManagerOptions) {
    this.opts = opts;
    this.heartbeatMs = opts.heartbeatMs ?? 10_000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 10_000;
    this.backoffMinMs = opts.backoffMinMs ?? 250;
    this.backoffMaxMs = opts.backoffMaxMs ?? 4000;
    this.collectTimeoutMs = opts.collectTimeoutMs ?? 3000;
    for (const m of opts.machines) {
      if (m.id === LOCAL_MACHINE_ID || this.runtimes.has(m.id)) {
        throw new Error(`machine id '${m.id}' is reserved or duplicated`);
      }
      this.runtimes.set(m.id, this.newRuntime(m));
    }
  }

  private newRuntime(cfg: MachineConfig): MachineRuntime {
    return {
      cfg,
      state: cfg.enabled ? 'connecting' : 'disabled',
      lastSeenAt: null,
      attempts: 0,
      conn: null,
      stream: null,
      dialing: false,
      redialTimer: null,
      heartbeatTimer: null,
      heartbeatInFlight: false,
      backoffMs: this.backoffMinMs,
      attachedSids: new Set(),
      attachments: new Set(),
      gen: 0,
    };
  }

  /** Begin dialing every enabled machine (idempotent). */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    for (const rt of this.runtimes.values()) {
      if (rt.cfg.enabled) {
        this.transition(rt, 'connecting', 'boot');
        this.dial(rt);
      }
    }
  }

  /** Drop every link and stop redialing (machine daemons keep running). */
  stop(): void {
    this.stopped = true;
    for (const rt of this.runtimes.values()) this.teardown(rt);
  }

  /** Live status of every registered machine (excludes the implicit local). */
  states(): MachineStateDto[] {
    return [...this.runtimes.values()].map((rt) => this.dtoOf(rt));
  }

  get(machineId: string): MachineStateDto | undefined {
    const rt = this.runtimes.get(machineId);
    return rt ? this.dtoOf(rt) : undefined;
  }

  /** True when the id names a registered machine (local is NOT one of these). */
  has(machineId: string): boolean {
    return this.runtimes.has(machineId);
  }

  /** Control-link child pid for stdio transports (gate-oracle test hook). */
  controlPid(machineId: string): number | null {
    const rt = this.runtimes.get(machineId);
    if (!rt?.conn || rt.conn.isClosed) return null;
    return rt.stream?.childPid ?? null;
  }

  /** Apply a new config set (add/remove/enable) — POST /api/machines/reload. */
  reload(machines: MachineConfig[]): void {
    // Validate the WHOLE set before touching any runtime — atomic apply.
    const nextIds = new Set<string>();
    for (const m of machines) {
      if (m.id === LOCAL_MACHINE_ID || nextIds.has(m.id)) {
        throw new Error(`machine id '${m.id}' is reserved or duplicated`);
      }
      nextIds.add(m.id);
    }
    // Removed machines: honest final transition, then gone.
    for (const [id, rt] of [...this.runtimes]) {
      if (nextIds.has(id)) continue;
      this.teardown(rt);
      if (rt.state !== 'disabled') this.transition(rt, 'disabled', 'disabled');
      this.runtimes.delete(id);
    }
    for (const m of machines) {
      const rt = this.runtimes.get(m.id);
      if (!rt) {
        // Newly added machine.
        const fresh = this.newRuntime(m);
        this.runtimes.set(m.id, fresh);
        if (m.enabled && this.started) {
          this.transition(fresh, 'connecting', 'boot');
          this.dial(fresh);
        }
        continue;
      }
      const transportChanged = JSON.stringify(rt.cfg.transport) !== JSON.stringify(m.transport);
      const wasEnabled = rt.cfg.enabled;
      rt.cfg = m;
      if (wasEnabled && !m.enabled) {
        this.teardown(rt);
        this.transition(rt, 'disabled', 'disabled');
      } else if (!wasEnabled && m.enabled) {
        this.transition(rt, 'connecting', 'enabled');
        if (this.started) this.dial(rt);
      } else if (m.enabled && transportChanged) {
        // Same machine, new pipe: drop the old link and redial the new spec.
        this.teardown(rt);
        this.transition(rt, 'connecting', 'enabled');
        if (this.started) this.dial(rt);
      }
    }
  }

  // --- FSM internals --------------------------------------------------------

  private dtoOf(rt: MachineRuntime): MachineStateDto {
    return {
      id: rt.cfg.id,
      label: rt.cfg.label,
      state: rt.state,
      lastSeenAt: rt.lastSeenAt,
      ...(rt.hostId !== undefined ? { hostId: rt.hostId } : {}),
      ...(rt.bootId !== undefined ? { bootId: rt.bootId } : {}),
      ...(rt.attempts > 0 ? { attempts: rt.attempts } : {}),
      ...(rt.lastError !== undefined ? { lastError: rt.lastError } : {}),
    };
  }

  /** The single transition point: every state change emits exactly one event. */
  private transition(
    rt: MachineRuntime,
    next: MachineConnectionState,
    code: MachineStateCode,
  ): void {
    const previous = rt.state;
    rt.state = next;
    this.opts.onState({
      machineId: rt.cfg.id,
      previous,
      state: next,
      lastSeenAt: rt.lastSeenAt,
      code,
    });
  }

  /** Close the link + timers WITHOUT emitting (callers own the transition). */
  private teardown(rt: MachineRuntime): void {
    rt.gen++;
    rt.dialing = false;
    if (rt.redialTimer) {
      clearTimeout(rt.redialTimer);
      rt.redialTimer = null;
    }
    this.stopHeartbeat(rt);
    for (const att of [...rt.attachments]) att.close();
    rt.attachments.clear();
    rt.attachedSids.clear();
    const conn = rt.conn;
    rt.conn = null;
    rt.stream = null;
    conn?.close();
    rt.backoffMs = this.backoffMinMs;
  }

  /**
   * True when a dial begun at `gen` must drop its result. Kept as a method on
   * purpose: `rt.state` mutates across the dial's awaits (reload/stop), and
   * inlined checks would let TS carry stale narrowing through the closure.
   */
  private dialSuperseded(rt: MachineRuntime, gen: number): boolean {
    return gen !== rt.gen || this.stopped || rt.state === 'disabled';
  }

  private dial(rt: MachineRuntime): void {
    if (this.stopped || rt.dialing || rt.conn !== null || rt.state === 'disabled') return;
    rt.dialing = true;
    const gen = rt.gen;
    void (async () => {
      const transport = transportForSpec(rt.cfg.transport, {
        connectTimeoutMs: this.requestTimeoutMs,
        onStderr: (chunk) => this.opts.onStderr?.(rt.cfg.id, chunk),
      });
      const stream = await transport.connect();
      if (this.dialSuperseded(rt, gen)) {
        stream.close();
        return;
      }
      let conn: HostConnection;
      try {
        // Placeholder token: SSH authenticated the peer; the relay rewrites it
        // with the remote daemon's own host-token. We never hold remote creds.
        conn = await HostConnection.openOnStream(stream, '', {
          requestTimeoutMs: this.requestTimeoutMs,
          agent: true,
        });
      } catch (e) {
        stream.close();
        throw e;
      }
      if (this.dialSuperseded(rt, gen)) {
        conn.close();
        return;
      }
      this.onConnected(rt, conn, stream);
    })().catch((e: unknown) => {
      if (this.dialSuperseded(rt, gen)) return;
      rt.dialing = false;
      rt.attempts++;
      rt.lastError = e instanceof TransportDialError ? e.code : 'dial_failed';
      // Never-reached machines stay `connecting`; a stale machine STAYS stale
      // (its lastSeenAt is real information a downgrade would destroy).
      this.transition(rt, rt.state === 'stale' ? 'stale' : 'connecting', 'dial_failed');
      this.scheduleRedial(rt);
    });
  }

  private onConnected(rt: MachineRuntime, conn: HostConnection, stream: FrameStream): void {
    rt.dialing = false;
    rt.conn = conn;
    rt.stream = stream;
    rt.attempts = 0;
    delete rt.lastError;
    rt.backoffMs = this.backoffMinMs;
    rt.lastSeenAt = Date.now();
    const hello = conn.helloOk;
    rt.hostId = hello.hostId;
    rt.bootId = hello.bootId;
    const resumed = rt.lastBootId !== undefined && rt.lastBootId === hello.bootId;
    rt.lastBootId = hello.bootId;
    rt.attachedSids.clear();

    conn.onCtrlMessage((msg) => {
      if (msg.t === 'exit') {
        rt.attachedSids.delete(msg.sid);
        this.opts.onExit?.(rt.cfg.id, {
          sid: msg.sid,
          code: msg.code,
          signal: msg.signal ?? null,
        });
      }
    });
    conn.onClose(() => {
      if (rt.conn !== conn) return;
      rt.conn = null;
      const hadChild = stream.childPid !== undefined;
      rt.stream = null;
      rt.attachedSids.clear();
      this.stopHeartbeat(rt);
      // Close-on-stale: viewers of this machine get an honest 1011 now, not a
      // half-dead pipe later. Local sessions are untouched.
      for (const att of [...rt.attachments]) att.close();
      rt.attachments.clear();
      if (!this.stopped && rt.state === 'connected') {
        this.transition(rt, 'stale', hadChild ? 'relay_exit' : 'link_closed');
      }
      if (!this.stopped && rt.state !== 'disabled') this.scheduleRedial(rt);
    });

    this.transition(rt, 'connected', 'dial_ok');
    this.opts.onUp?.(rt.cfg.id, {
      hostId: hello.hostId,
      bootId: hello.bootId,
      resumed,
      sessions: hello.sessions,
    });
    this.startHeartbeat(rt);
  }

  private startHeartbeat(rt: MachineRuntime): void {
    this.stopHeartbeat(rt);
    rt.heartbeatTimer = setInterval(() => {
      const conn = rt.conn;
      if (!conn || conn.isClosed || rt.heartbeatInFlight) return;
      rt.heartbeatInFlight = true;
      conn
        .request({ t: 'list', reqId: crypto.randomUUID() })
        .then(() => {
          rt.heartbeatInFlight = false;
          if (rt.conn === conn) rt.lastSeenAt = Date.now();
        })
        .catch(() => {
          rt.heartbeatInFlight = false;
          if (rt.conn !== conn || conn.isClosed) return; // link already handled
          // Missed heartbeat: the link is dead to us. Transition FIRST (so the
          // close handler sees state!=='connected'), then destroy the stream.
          if (rt.state === 'connected') this.transition(rt, 'stale', 'heartbeat_timeout');
          conn.close();
        });
    }, this.heartbeatMs);
  }

  private stopHeartbeat(rt: MachineRuntime): void {
    if (rt.heartbeatTimer) {
      clearInterval(rt.heartbeatTimer);
      rt.heartbeatTimer = null;
    }
    rt.heartbeatInFlight = false;
  }

  private scheduleRedial(rt: MachineRuntime): void {
    if (this.stopped || rt.redialTimer || rt.state === 'disabled') return;
    const delay = rt.backoffMs;
    rt.backoffMs = Math.min(rt.backoffMs * 2, this.backoffMaxMs);
    rt.redialTimer = setTimeout(() => {
      rt.redialTimer = null;
      this.dial(rt);
    }, delay);
  }

  private runtime(machineId: string): MachineRuntime {
    const rt = this.runtimes.get(machineId);
    if (!rt) throw new UnknownMachineError(machineId);
    return rt;
  }

  /** The machine's live control link, or an honest availability error. */
  private control(machineId: string): { rt: MachineRuntime; conn: HostConnection } {
    const rt = this.runtime(machineId);
    if (!rt.conn || rt.conn.isClosed || rt.state !== 'connected') {
      throw new MachineUnavailableError(machineId, rt.state);
    }
    return { rt, conn: rt.conn };
  }

  /** Refresh lastSeenAt on any successful request (verified contact). */
  private sawReply(rt: MachineRuntime, conn: HostConnection): void {
    if (rt.conn === conn) rt.lastSeenAt = Date.now();
  }

  // --- remote session operations (control link) ----------------------------

  async spawn(machineId: string, spec: SpawnSpec): Promise<{ sid: number; pid: number }> {
    const { rt, conn } = this.control(machineId);
    const reply = await conn.request({ t: 'spawn', reqId: crypto.randomUUID(), spec });
    if (reply.t !== 'spawned') throw new Error(`unexpected reply ${reply.t}`);
    this.sawReply(rt, conn);
    // The spawning connection is auto-attached read-write by the daemon.
    rt.attachedSids.add(reply.sid);
    return { sid: reply.sid, pid: reply.pid };
  }

  async list(machineId: string): Promise<SessionSummary[]> {
    const { rt, conn } = this.control(machineId);
    const reply = await conn.request({ t: 'list', reqId: crypto.randomUUID() });
    if (reply.t !== 'sessions') throw new Error(`unexpected reply ${reply.t}`);
    this.sawReply(rt, conn);
    return reply.sessions;
  }

  kill(machineId: string, sid: number, signal?: string): void {
    const { conn } = this.control(machineId);
    conn.send({ t: 'kill', sid, ...(signal !== undefined ? { signal } : {}) });
  }

  input(machineId: string, sid: number, data: Buffer): void {
    const { conn } = this.control(machineId);
    conn.input(sid, data);
  }

  /** Attach the control link (read-write) once, for directive input. */
  async ensureAttached(machineId: string, sid: number): Promise<void> {
    const { rt, conn } = this.control(machineId);
    if (rt.attachedSids.has(sid)) return;
    const reply = await conn.request({
      t: 'attach',
      reqId: crypto.randomUUID(),
      sid,
      // Directive input needs write access, not scrollback: replay from head.
      sinceSeq: Number.MAX_SAFE_INTEGER,
    });
    if (reply.t !== 'attached') throw new Error(`unexpected reply ${reply.t}`);
    this.sawReply(rt, conn);
    rt.attachedSids.add(sid);
  }

  /**
   * Dedicated per-viewer stream, mirrors PaneldClient.openAttachment: a FRESH
   * relay child per viewer, so the remote daemon enforces per-connection
   * readOnly/replay semantics unchanged.
   */
  async openAttachment(
    machineId: string,
    sid: number,
    opts: { sinceSeq?: number; readOnly?: boolean } = {},
  ): Promise<PtyAttachment> {
    const { rt } = this.control(machineId);
    const gen = rt.gen;
    const transport = transportForSpec(rt.cfg.transport, {
      connectTimeoutMs: this.requestTimeoutMs,
      onStderr: (chunk) => this.opts.onStderr?.(rt.cfg.id, chunk),
    });
    const stream = await transport.connect();
    let conn: HostConnection;
    try {
      conn = await HostConnection.openOnStream(stream, '', {
        requestTimeoutMs: this.requestTimeoutMs,
        agent: true,
      });
    } catch (e) {
      stream.close();
      throw e;
    }
    if (gen !== rt.gen || rt.state !== 'connected') {
      // The machine went stale/reloaded while we were dialing — honest refusal.
      conn.close();
      throw new MachineUnavailableError(machineId, rt.state);
    }
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
    let attached: Extract<Awaited<ReturnType<HostConnection['request']>>, { t: 'attached' }>;
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
    this.sawReply(rt, rt.conn ?? conn);

    const attachment: PtyAttachment = {
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
    rt.attachments.add(attachment);
    conn.onClose(() => rt.attachments.delete(attachment));
    return attachment;
  }

  /** Remote adapter-session discovery (relay-terminated `collect` CTRL). */
  async collect(machineId: string): Promise<Collected> {
    const { rt, conn } = this.control(machineId);
    // A collect failure is a per-machine fleet failure, NEVER a staleness
    // signal — the heartbeat owns liveness, so the link is left alone here.
    let reply;
    try {
      reply = await conn.request(
        { t: 'collect', reqId: crypto.randomUUID() },
        this.collectTimeoutMs,
      );
    } catch (e) {
      if (e instanceof HostUnavailableError) {
        throw new MachineUnavailableError(machineId, rt.state);
      }
      throw e;
    }
    if (reply.t !== 'collected') throw new Error(`unexpected reply ${reply.t}`);
    this.sawReply(rt, conn);
    return reply;
  }
}
