/**
 * The Terminull panel server — the long-lived HTTP + WS API every client
 * surface (web, mobile, plugins, Manage-Agent) builds on.
 *
 * Architecture (ported from the proven control-tower shape):
 *  - the server is the SINGLE SOURCE OF TRUTH: every mutation is a seq-numbered
 *    event in the {@link EventStore}; clients follow `WS /ws` and resync gaps
 *    via `GET /api/events?since=`;
 *  - `POST /api/events` is the hook ingress and accepts ONLY postable
 *    (informational, forgeable-by-design) types — guarded types flow through
 *    their own routes;
 *  - every state-changing route passes {@link TerminullServer.gate}: one
 *    permission decision point that audits `permission.checked`, returns 403
 *    for forbidden, and parks `confirm`-class actions in the confirmation
 *    queue for a `user` actor to approve;
 *  - PTYs live in the paneld daemon (sessions survive server restarts); the
 *    server is just another daemon client via {@link PaneldClient}.
 *
 * i18n rule: this server returns machine fields + stable message codes only —
 * clients own all human-readable strings.
 */
import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import {
  CORE_PLACEHOLDER,
  EventStore,
  HarnessFileEngine,
  NotPostableError,
  PermissionSettings,
  maskSecrets,
} from '@terminull/core';
import {
  PluginHost,
  type DiscoveredSession,
  type HarnessContext,
  type ToolAdapter,
} from '@terminull/adapter-sdk';
import {
  DEFAULT_PROFILE_ID,
  LOCAL_MACHINE_ID,
  PANEL_PROTO_VERSION,
  PtyClientMessageSchema,
  type Actor,
  type AgentStatusDto,
  type MachineConfig,
  type MachineConnectionState,
  type MachineStateCode,
  type MachineStateDto,
  type MachineStatePayload,
  type PanelEvent,
  type PanelHello,
  type ProposedActionKind,
  type PtyAttached,
  type PtyError,
  type SpawnSpec,
} from '@terminull/shared';
import {
  ClaudeBrainAdapter,
  DEFAULT_CAPS,
  createManageAgent,
  type BrainAdapter,
  type ManageAgent,
  type ManageAgentCaps,
} from '@terminull/manage-agent';
import * as claudePlugin from '@terminull/adapter-claude';
import * as codexPlugin from '@terminull/adapter-codex';
import * as genericPlugin from '@terminull/adapter-generic';
import * as agyPlugin from '@terminull/adapter-agy';
import { tmux } from '@terminull/session-host';
import { PERMISSION_TO_KIND, resultCodeOf } from './agent.js';
import { AgentExecutor, type AgentSpawnRequest } from './agent-executor.js';
import { registerAgentRoutes } from './agent-routes.js';
import { registerToolsRoutes } from './tools-routes.js';
import { Auth, TOKEN_COOKIE, originOk, type RequestActor } from './auth.js';
import { ConfirmationQueue, type GateResult } from './confirmations.js';
import { removeDiscovery, writeDiscovery } from './discovery.js';
import {
  collectFleet,
  remoteCollectedToFleet,
  remotePaneldFleetSessions,
  unreachableStatus,
  type FleetSnapshot,
} from './fleet.js';
import { BodyError, Router, fail, json, maskDeep, readJsonBody } from './http-util.js';
import {
  MachineManager,
  MachineUnavailableError,
  UnknownMachineError,
  loadMachinesFile,
  type MachineManagerOptions,
} from './machines.js';
import { registerMachinesRoutes } from './machines-routes.js';
import { HostRequestError, HostUnavailableError, PaneldClient } from './paneld-client.js';
import { registerHarnessRoutes } from './harness-routes.js';
import { ProfilesRegistry } from './profiles.js';
import { registerProfilesRoutes } from './profiles-routes.js';
import { registerPrefsRoutes } from './prefs-routes.js';
import { SessionStatusMap, registerSessionStatusRoutes } from './session-status.js';
import { SessionRegistry, type ServerSession } from './sessions.js';
import { StaticUi } from './static-ui.js';

/** Default listen port. */
export const DEFAULT_PORT = 7420;
/** Default listen host — loopback only; widening is an explicit choice. */
export const DEFAULT_HOST = '127.0.0.1';
/** Commands the generic adapter may spawn (basename match). */
export const DEFAULT_SPAWN_ALLOWLIST = ['sh', 'bash', 'zsh'];

/** Thrown when a wildcard bind is requested without `unsafeBind`. */
export class UnsafeBindError extends Error {
  readonly code = 'unsafe_bind_refused';
  constructor(host: string) {
    super(
      `refusing to bind '${host}': a wildcard bind exposes session control, ` +
        `PTY input and the event log to every host on the network; pass ` +
        `--unsafe-bind only behind a trusted interface/firewall`,
    );
    this.name = 'UnsafeBindError';
  }
}

/** Options accepted by {@link createTerminullServer}. */
export interface ServerOptions {
  /** Server state dir (events.jsonl, token, server.json, permissions.json, host/). */
  stateDir: string;
  /**
   * Built web-panel bundle dir (the SPA the panel server hosts). Absent or
   * missing → the honest smoke page is served at `/`. The CLI resolves this for
   * both the published tarball (`web-dist/`) and the dev repo
   * (`packages/web/dist`); see {@link StaticUi}.
   */
  uiDir?: string;
  /** Listen host. Non-loopback prints nothing here; wildcard needs unsafeBind. */
  host?: string;
  /** Listen port (0 = ephemeral). Default {@link DEFAULT_PORT}. */
  port?: number;
  /** Allow binding 0.0.0.0/:: (see {@link UnsafeBindError}). */
  unsafeBind?: boolean;
  /** Trust loopback for authed() (default true). */
  trustLoopback?: boolean;
  /** Pre-configured plugin host; defaults to built-ins (claude + generic). */
  pluginHost?: PluginHost;
  /** paneld state dir. Default `<stateDir>/host`. */
  hostStateDir?: string;
  /** Override the paneld bin path (tests). */
  paneldBin?: string;
  /** Spawn paneld when its socket is dead (default true). */
  spawnPaneldIfDead?: boolean;
  /** Home dir handed to adapter collectors (tests point this at a fixture). */
  collectHome?: string;
  /** Command used for claude spawns (default 'claude'). */
  claudeCmd?: string;
  /** Command used for codex spawns (default 'codex'). */
  codexCmd?: string;
  /** Command used for agy spawns (default 'agy'). */
  agyCmd?: string;
  /** Generic-adapter spawn allowlist (basenames). */
  spawnAllowlist?: string[];
  /** Fleet snapshot cache TTL in ms (default 2000). */
  fleetTtlMs?: number;
  /** Manage-agent brain backend (tests inject a FakeBrain — NEVER a real CLI). */
  agentBrain?: BrainAdapter;
  /** Manage-agent hard caps (merged over {@link DEFAULT_CAPS}). */
  agentCaps?: Partial<ManageAgentCaps>;
  /** Enable the manage agent (default true; disabled → chat 409). */
  agentEnabled?: boolean;
  /**
   * Remote machine registry (M8). Overrides `<stateDir>/machines.json`;
   * tests inject stdio-transport machines here — NEVER real ssh hosts.
   */
  machines?: MachineConfig[];
  /** Machine link timings (heartbeat/backoff/collect), test-injectable. */
  machineTimings?: Pick<
    MachineManagerOptions,
    'heartbeatMs' | 'requestTimeoutMs' | 'backoffMinMs' | 'backoffMaxMs' | 'collectTimeoutMs'
  >;
}

function readServerVersion(): string {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Register the built-in plugins on a fresh host (same path 3rd-parties use). */
export function defaultPluginHost(): PluginHost {
  const host = new PluginHost();
  host.register(claudePlugin.manifest, () => claudePlugin);
  host.register(codexPlugin.manifest, () => codexPlugin);
  host.register(agyPlugin.manifest, () => agyPlugin);
  host.register(genericPlugin.manifest, () => genericPlugin);
  host.instantiateAll();
  return host;
}

// --- request body schemas (strict: unknown keys are contract violations) ----

const PostEventSchema = z
  .object({
    type: z.string().min(1),
    sessionId: z.string().min(1).optional(),
    tool: z.string().min(1).optional(),
    payload: z.unknown().optional(),
  })
  .strict();

const DirectiveSchema = z
  .object({ sessionId: z.string().min(1), text: z.string().min(1) })
  .strict();

const SpawnBodySchema = z
  .object({
    adapterId: z.string().min(1),
    cwd: z.string().min(1),
    model: z.string().min(1).optional(),
    permissionMode: z.string().min(1).optional(),
    cmd: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    label: z.string().min(1).max(120).optional(),
    cols: z.number().int().positive().max(1000).optional(),
    rows: z.number().int().positive().max(1000).optional(),
    /** Target machine id (M8). Absent = the local paneld. */
    machine: z.string().min(1).optional(),
    /** Account profile override (M9). Absent = the tool's active profile. */
    profile: z.string().min(1).optional(),
  })
  .strict();

const DeleteSessionSchema = z.object({ confirmPhrase: z.string().optional() }).strict();

export class TerminullServer {
  readonly stateDir: string;
  readonly store: EventStore;
  readonly permissions: PermissionSettings;
  readonly auth: Auth;
  readonly registry = new SessionRegistry();
  readonly confirmations = new ConfirmationQueue();
  readonly paneld: PaneldClient;
  /** The remote machine registry + links (public: the gate oracle drives it). */
  readonly machines: MachineManager;
  readonly pluginHost: PluginHost;
  /** The manage-agent executor (public: the integration oracle drives it). */
  readonly agentActions: AgentExecutor;
  /** Account-profile registry (M9) — `<stateDir>/profiles.json`. */
  readonly profiles: ProfilesRegistry;

  private readonly harnessEngine: HarnessFileEngine;
  private readonly sessionStatuses = new SessionStatusMap();
  /** Static host for the built web panel (or the smoke-page fallback). */
  private readonly ui: StaticUi;

  private readonly adaptersById = new Map<string, ToolAdapter>();
  private readonly manageAgent: ManageAgent;
  private readonly agentBrain: BrainAdapter;
  private readonly agentCaps: ManageAgentCaps;
  private readonly agentEnabled: boolean;
  private readonly router = new Router();
  private readonly httpServer: http.Server;
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly version = readServerVersion();
  private readonly startedAt = Date.now();
  private readonly opts: ServerOptions;
  private fleetCache: { at: number; snap: FleetSnapshot } | null = null;
  private boundPort: number | null = null;
  /** Local machine mirror: one uniform machine rail incl. this host's paneld. */
  private localMachineState: MachineConnectionState = 'connecting';
  private localLastSeenAt: number | null = null;

  constructor(opts: ServerOptions) {
    this.opts = opts;
    this.stateDir = opts.stateDir;
    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });

    this.store = new EventStore({ stateDir: this.stateDir, machine: os.hostname() });
    this.store.load();
    this.permissions = PermissionSettings.load(path.join(this.stateDir, 'permissions.json'));
    this.auth = new Auth({
      stateDir: this.stateDir,
      ...(opts.trustLoopback !== undefined ? { trustLoopback: opts.trustLoopback } : {}),
    });

    this.pluginHost = opts.pluginHost ?? defaultPluginHost();
    for (const [id, lazy] of this.pluginHost.adapters()) {
      try {
        this.adaptersById.set(id, lazy.load());
      } catch {
        // instantiateAll() already recorded the disable reason; skip honestly.
      }
    }

    this.paneld = new PaneldClient({
      hostStateDir: opts.hostStateDir ?? path.join(this.stateDir, 'host'),
      ...(opts.paneldBin !== undefined ? { paneldBin: opts.paneldBin } : {}),
      ...(opts.spawnPaneldIfDead !== undefined ? { spawnIfDead: opts.spawnPaneldIfDead } : {}),
      onUp: (info) => {
        const ended = this.registry.reconcile(info.sessions, info.resumed);
        for (const s of ended) {
          this.store.append('session.end', {
            sessionId: s.id,
            tool: s.adapterId,
            payload: { reason: 'host_restarted', sid: s.sid },
          });
        }
        this.store.append('host.up', {
          payload: {
            hostId: info.hostId,
            bootId: info.bootId,
            resumed: info.resumed,
            sessions: info.sessions.length,
          },
        });
        // Local machine mirror (M8): 'local' rides the same machine.state rail
        // as remote machines; host.up/host.down stay untouched for compat.
        this.localLastSeenAt = Date.now();
        this.setLocalMachineState('connected', 'dial_ok');
      },
      onDown: () => {
        this.store.append('host.down', { payload: {} });
        this.setLocalMachineState('stale', 'link_closed');
      },
      onExit: (exit) => {
        const s = this.registry.markExited(exit.sid);
        if (s) {
          this.store.append('session.end', {
            sessionId: s.id,
            tool: s.adapterId,
            payload: { reason: 'exited', sid: exit.sid, code: exit.code, signal: exit.signal },
          });
        }
      },
    });

    // --- machine registry (M8) -----------------------------------------------
    // Boot honesty: a corrupt machines.json throws here — a half-read machine
    // registry must never boot silently (contract §5).
    this.machines = new MachineManager({
      machines: opts.machines ?? loadMachinesFile(this.stateDir),
      ...opts.machineTimings,
      onState: (payload: MachineStatePayload) => {
        this.store.append('machine.state', { actor: 'system', payload });
        this.fleetCache = null;
      },
      onStderr: (id, chunk) => this.appendMachineLog(id, chunk),
      onUp: (machineId, info) => {
        const ended = this.registry.reconcile(info.sessions, info.resumed, machineId);
        for (const s of ended) {
          this.store.append('session.end', {
            sessionId: s.id,
            tool: s.adapterId,
            payload: { reason: 'host_restarted', sid: s.sid, machine: machineId },
          });
        }
        this.fleetCache = null;
      },
      onExit: (machineId, exit) => {
        const s = this.registry.markExited(exit.sid, machineId);
        if (s) {
          this.store.append('session.end', {
            sessionId: s.id,
            tool: s.adapterId,
            payload: {
              reason: 'exited',
              sid: exit.sid,
              code: exit.code,
              signal: exit.signal,
              machine: machineId,
            },
          });
          this.fleetCache = null;
        }
      },
    });

    // --- profiles + harness editor (M9) ---------------------------------------
    // Boot honesty: a corrupt profiles.json throws here — a half-read profile
    // registry must never boot silently (mirrors machines.json, contract D1).
    this.profiles = new ProfilesRegistry(this.stateDir);
    this.harnessEngine = new HarnessFileEngine({
      backupsDir: path.join(this.stateDir, 'harness-backups'),
      // Jail roots: the harness home + the cwd-scoped project root (D4). The
      // engine re-asserts this on every write — defence in depth over catalog
      // membership.
      jailRoots: [this.harnessCtx().home ?? os.homedir(), process.cwd()],
    });

    // --- manage agent mount --------------------------------------------------
    // The agent NEVER touches the panel directly: its only effect channel is
    // this PanelActions executor, gated as the 'agent' actor, and its only
    // event channel is the audit emitter below. It has NO permission-settings
    // surface (facade omits it; core `set()` additionally throws for agents).
    this.agentCaps = { ...DEFAULT_CAPS, ...opts.agentCaps };
    // Default brain = the claude-headless subprocess adapter (manage-agent v1).
    // It touches nothing at construction; probing happens lazily on first chat.
    // Tests ALWAYS inject a FakeBrain here — unit tests never spawn a real CLI.
    this.agentBrain = opts.agentBrain ?? new ClaudeBrainAdapter();
    this.agentEnabled = opts.agentEnabled ?? true;
    this.agentActions = new AgentExecutor({
      store: this.store,
      permissions: this.permissions,
      confirmations: this.confirmations,
      registry: this.registry,
      paneld: this.paneld,
      adapters: this.adaptersById,
      spawnAllowlist: opts.spawnAllowlist ?? DEFAULT_SPAWN_ALLOWLIST,
      deliverDirective: (sessionId, text, actor) => this.deliverDirective(sessionId, text, actor),
      spawnSession: (request) => this.spawnFromAgent(request),
      fleetSnapshot: () => this.fleetSnapshot(),
    });
    this.manageAgent = createManageAgent({
      brain: this.agentBrain,
      actions: this.agentActions,
      emit: (type, payload) => {
        this.store.append(type, { actor: 'agent', payload: maskDeep(payload) });
      },
      caps: this.agentCaps,
      // Status honesty: the confirmation queue is the single source of truth
      // for pending approvals — the supervisor derives its count (and clears a
      // stale awaiting_approval) from this live provider at every status read.
      pendingCount: () => this.agentPendingCount(),
    });

    // Static web-panel host: serves the built SPA when `uiDir` is present,
    // else the smoke page (resolved with the same `./smoke/index.html`-relative
    // path that survives the tsup bundle → `<bundle>/smoke/index.html`).
    this.ui = new StaticUi({
      ...(opts.uiDir !== undefined ? { uiDir: opts.uiDir } : {}),
      smokePath: fileURLToPath(new URL('./smoke/index.html', import.meta.url)),
    });

    this.buildRoutes();
    this.httpServer = http.createServer((req, res) => void this.handleRequest(req, res));
    this.httpServer.on('upgrade', (req, socket, head) => {
      try {
        if (!originOk(req) || !this.auth.authed(req)) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        if (url.pathname === '/ws') {
          this.wss.handleUpgrade(req, socket, head, (ws) => this.onWsEvents(ws));
        } else if (url.pathname === '/pty') {
          const actor = this.auth.actorOf(req);
          this.wss.handleUpgrade(req, socket, head, (ws) => void this.onWsPty(ws, url, actor));
        } else {
          socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
          socket.destroy();
        }
      } catch {
        socket.destroy();
      }
    });
  }

  /** The bound port after {@link listen} (null before). */
  get port(): number | null {
    return this.boundPort;
  }

  /** Bind + start. Resolves with the real port (ephemeral-safe). */
  async listen(): Promise<{ port: number }> {
    const host = this.opts.host ?? DEFAULT_HOST;
    if ((host === '0.0.0.0' || host === '::' || host === '') && !this.opts.unsafeBind) {
      throw new UnsafeBindError(host);
    }
    await this.paneld.start();
    this.machines.start();
    await new Promise<void>((resolve, reject) => {
      this.httpServer.once('error', reject);
      this.httpServer.listen(this.opts.port ?? DEFAULT_PORT, host, () => resolve());
    });
    const addr = this.httpServer.address();
    this.boundPort =
      addr !== null && typeof addr === 'object' ? addr.port : (this.opts.port ?? DEFAULT_PORT);
    writeDiscovery(this.stateDir, {
      port: this.boundPort,
      coreVersion: CORE_PLACEHOLDER.version,
    });
    return { port: this.boundPort };
  }

  /** Clean shutdown: discovery removed, WS dropped, daemon left running. */
  async close(): Promise<void> {
    removeDiscovery(this.stateDir);
    this.machines.stop();
    this.paneld.stop();
    for (const client of this.wss.clients) client.terminate();
    await new Promise<void>((resolve) => {
      this.httpServer.close(() => resolve());
      this.httpServer.closeAllConnections();
    });
  }

  // -------------------------------------------------------------------------
  // gate — the single permission decision point
  // -------------------------------------------------------------------------

  private effectiveActor(actor: RequestActor): Actor {
    // No positive signal gates exactly like an agent (fail-toward-restrictive);
    // the raw classification is still recorded honestly in payloads.
    return actor === 'unknown' ? 'agent' : actor;
  }

  private async gate(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    action: string,
    opts: {
      sessionId?: string;
      params?: unknown;
      execute: (actor: Actor) => Promise<GateResult>;
    },
  ): Promise<void> {
    const requestActor = this.auth.actorOf(req);
    const actor = this.effectiveActor(requestActor);
    const check = this.permissions.check(action, actor);
    this.store.append('permission.checked', {
      actor,
      ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
      payload: {
        action,
        decision: check.allowed,
        requestActor,
        resolvedClass: check.resolvedClass,
        requiresTwoStep: check.requiresTwoStep,
      },
    });
    if (check.allowed === 'no') {
      fail(res, 403, 'forbidden', { action });
      return;
    }
    if (check.allowed === 'confirm') {
      const pending = this.confirmations.add({
        action,
        actor: requestActor,
        ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
        params: maskDeep(opts.params ?? {}),
        execute: () => opts.execute(actor),
      });
      this.store.append('confirmation.pending', {
        actor,
        ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
        payload: { confirmationId: pending.id, action, params: pending.params },
      });
      json(res, 202, { code: 'pending_confirmation', confirmationId: pending.id, action });
      return;
    }
    const result = await opts.execute(actor);
    json(res, result.status, result.body);
  }

  // -------------------------------------------------------------------------
  // request plumbing
  // -------------------------------------------------------------------------

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      // /auth is the only unauthenticated route — it CARRIES the credential.
      if (url.pathname !== '/auth' && !this.auth.authed(req)) {
        fail(res, 401, 'unauthorized');
        return;
      }
      const method = req.method ?? 'GET';
      if (method !== 'GET' && method !== 'HEAD' && !originOk(req)) {
        fail(res, 403, 'origin_mismatch');
        return;
      }
      const match = this.router.match(method, url.pathname);
      if (match) {
        await match.handler(req, res, match.params, url);
        return;
      }
      // No API/WS route matched. GET/HEAD fall through to the static web panel
      // (real asset, SPA deep-link → index.html, or the smoke fallback). A
      // static miss (reserved namespace, missing asset) returns an honest 404.
      if ((method === 'GET' || method === 'HEAD') && this.ui.serve(res, url.pathname, method)) {
        return;
      }
      fail(res, 404, 'not_found');
    } catch (e) {
      // Degrade, never crash: every route failure becomes a coded 5xx/4xx.
      if (e instanceof BodyError) {
        if (!res.headersSent) fail(res, e.status, e.code);
        return;
      }
      if (!res.headersSent) fail(res, 500, 'internal_error');
    }
  }

  private async fleetSnapshot(): Promise<FleetSnapshot> {
    const ttl = this.opts.fleetTtlMs ?? 2000;
    if (this.fleetCache && Date.now() - this.fleetCache.at < ttl) return this.fleetCache.snap;
    const snap = await collectFleet(this.adaptersById, this.registry, {
      home: this.opts.collectHome ?? os.homedir(),
      now: Date.now(),
    });
    // M8: machines[] is ALWAYS present (local-only installs included). Only
    // CONNECTED machines contribute sessions — a stale machine's entry (with
    // lastSeenAt) is the honest signal; its sessions are never ghosted.
    snap.machines = [this.localMachineDto(), ...this.machines.states()];
    await Promise.all(
      this.machines.states().map(async (m) => {
        if (m.state !== 'connected') return;
        let unreachable = false;
        try {
          const sessions = await this.machines.list(m.id);
          snap.sessions.push(...remotePaneldFleetSessions(m.id, sessions, this.registry));
        } catch {
          unreachable = true;
        }
        try {
          const collected = await this.machines.collect(m.id);
          const mapped = remoteCollectedToFleet(m.id, collected);
          snap.adapters.push(...mapped.statuses);
          snap.sessions.push(...mapped.sessions);
        } catch {
          unreachable = true;
        }
        if (unreachable) snap.adapters.push(unreachableStatus(m.id));
      }),
    );
    snap.sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    this.fleetCache = { at: Date.now(), snap };
    return snap;
  }

  /** The implicit local machine's rail entry (mirrors the paneld link state). */
  private localMachineDto(): MachineStateDto {
    return {
      id: LOCAL_MACHINE_ID,
      label: LOCAL_MACHINE_ID,
      state: this.localMachineState,
      lastSeenAt: this.localLastSeenAt,
      ...(this.paneld.bootId !== null ? { bootId: this.paneld.bootId } : {}),
    };
  }

  /** Emit `machine.state` for the local mirror on real transitions only. */
  private setLocalMachineState(state: MachineConnectionState, code: MachineStateCode): void {
    if (this.localMachineState === state) return;
    const previous = this.localMachineState;
    this.localMachineState = state;
    const payload: MachineStatePayload = {
      machineId: LOCAL_MACHINE_ID,
      previous,
      state,
      lastSeenAt: this.localLastSeenAt,
      code,
    };
    this.store.append('machine.state', { actor: 'system', payload });
    this.fleetCache = null;
  }

  /** Relay stderr sink: `<stateDir>/machines/<id>.log`, secrets masked. */
  private appendMachineLog(id: string, chunk: string): void {
    try {
      const dir = path.join(this.stateDir, 'machines');
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.appendFileSync(path.join(dir, `${id}.log`), maskSecrets(chunk), { mode: 0o600 });
    } catch {
      // Diagnostics only — a log-write failure must never take the link down.
    }
  }

  // -------------------------------------------------------------------------
  // routes
  // -------------------------------------------------------------------------

  private buildRoutes(): void {
    const r = this.router;

    r.add('GET', '/api/health', (_req, res) => {
      json(res, 200, {
        ok: true,
        version: this.version,
        seq: this.store.seq,
        // `known:false` = the daemon is unreachable, so the count is only what
        // we last knew — never presented as verified.
        sessions: { count: this.registry.liveCount(), known: this.paneld.connected },
        host: { connected: this.paneld.connected },
        uptime: Math.round((Date.now() - this.startedAt) / 1000),
      });
    });

    r.add('GET', '/api/fleet', async (_req, res) => {
      json(res, 200, await this.fleetSnapshot());
    });

    r.add('GET', '/api/events', (_req, res, _params, url) => {
      const raw = url.searchParams.get('since') ?? '0';
      const since = Number(raw);
      if (!Number.isInteger(since) || since < 0) {
        fail(res, 400, 'bad_request', { param: 'since' });
        return;
      }
      const events = this.store.eventsSince(since);
      // The in-memory inbox is bounded: if events between `since` and its
      // oldest entry have fallen out, say so instead of resyncing silently.
      const first = this.store.inbox[0];
      const oldestAvailable = first !== undefined ? first.seq : this.store.seq + 1;
      const gap = this.store.seq > since && since + 1 < oldestAvailable;
      json(res, 200, { events, seq: this.store.seq, gap });
    });

    r.add('POST', '/api/events', async (req, res) => {
      const body = PostEventSchema.safeParse(await readJsonBody(req));
      if (!body.success) {
        fail(res, 400, 'bad_request');
        return;
      }
      const { type, sessionId, tool, payload } = body.data;
      try {
        const ev = this.store.appendExternal(type, {
          ...(sessionId !== undefined ? { sessionId } : {}),
          ...(tool !== undefined ? { tool } : {}),
          ...(payload !== undefined ? { payload: maskDeep(payload) } : {}),
        });
        // M9 statusbar: fold the latest snapshot per tool-native session id.
        // Invalid payloads are dropped by the fold (display-only, never coerced).
        if (type === 'session.status') this.sessionStatuses.ingest(payload);
        json(res, 201, { seq: ev.seq });
      } catch (e) {
        if (e instanceof NotPostableError) {
          fail(res, 400, 'not_postable', { type });
          return;
        }
        throw e;
      }
    });

    r.add('POST', '/api/directive', async (req, res) => {
      const body = DirectiveSchema.safeParse(await readJsonBody(req));
      if (!body.success) {
        fail(res, 400, 'bad_request');
        return;
      }
      const { sessionId, text } = body.data;
      await this.gate(req, res, 'directive.send', {
        sessionId,
        params: { sessionId, text: maskSecrets(text) },
        execute: (actor) => this.deliverDirective(sessionId, text, actor),
      });
    });

    r.add('POST', '/api/sessions', async (req, res) => {
      const body = SpawnBodySchema.safeParse(await readJsonBody(req));
      if (!body.success) {
        fail(res, 400, 'bad_request');
        return;
      }
      // Validate BEFORE gating so a malformed request never parks a pending
      // confirmation the user would approve into an error.
      const spec = this.buildSpawnCommand(body.data);
      if ('error' in spec) {
        fail(res, 400, spec.error, spec.extra ?? {});
        return;
      }
      const machineId = body.data.machine ?? LOCAL_MACHINE_ID;
      if (machineId !== LOCAL_MACHINE_ID) {
        const machine = this.machines.get(machineId);
        if (!machine) {
          fail(res, 400, 'unknown_machine', { machine: machineId });
          return;
        }
        if (machine.state !== 'connected') {
          fail(res, 503, 'machine_unavailable', { machine: machineId, state: machine.state });
          return;
        }
      }
      const profile = this.resolveSpawnProfile(body.data.adapterId, body.data.profile, machineId);
      if ('error' in profile) {
        fail(res, profile.status, profile.error, profile.extra ?? {});
        return;
      }
      await this.gate(req, res, 'session.spawn', {
        params: {
          adapterId: body.data.adapterId,
          cwd: body.data.cwd,
          cmd: spec.cmd,
          machine: machineId,
          profile: profile.profileId,
        },
        execute: (actor) => this.spawnSession(body.data, spec, actor, profile),
      });
    });

    r.add('DELETE', '/api/sessions/:sid', async (req, res, params) => {
      const session = this.registry.get(params['sid'] ?? '');
      if (!session) {
        fail(res, 404, 'not_found');
        return;
      }
      const body = DeleteSessionSchema.safeParse(await readJsonBody(req));
      if (!body.success) {
        fail(res, 400, 'bad_request');
        return;
      }
      // Server-side half of the two-step: the exact session label must be
      // retyped, for EVERY actor class, no exceptions.
      if (body.data.confirmPhrase !== session.label) {
        fail(res, 400, 'confirm_phrase_mismatch', { expected: 'session_label' });
        return;
      }
      await this.gate(req, res, 'session.delete', {
        sessionId: session.id,
        params: { sessionId: session.id, label: session.label },
        execute: () => this.killSession(session),
      });
    });

    r.add('GET', '/api/sessions/:sid/transcript', async (_req, res, params, url) => {
      await this.readTranscript(res, params['sid'] ?? '', url.searchParams.get('cursor'));
    });

    r.add('GET', '/api/confirmations', (_req, res) => {
      json(res, 200, { pending: this.confirmations.list() });
    });

    r.add('POST', '/api/confirmations/:id/approve', async (req, res, params) => {
      await this.resolveConfirmation(req, res, params['id'] ?? '', 'approve');
    });

    r.add('POST', '/api/confirmations/:id/reject', async (req, res, params) => {
      await this.resolveConfirmation(req, res, params['id'] ?? '', 'reject');
    });

    r.add('GET', '/auth', (_req, res, _params, url) => {
      const token = url.searchParams.get('token') ?? '';
      if (!this.auth.tokenMatches(token)) {
        fail(res, 403, 'unauthorized');
        return;
      }
      res.writeHead(302, {
        'set-cookie': `${TOKEN_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict`,
        location: '/',
      });
      res.end();
    });

    // `GET /` (+ every other non-API GET) is served by the static web panel in
    // handleRequest's fall-through — see {@link StaticUi}. The smoke page is the
    // honest fallback when no web bundle is configured.

    // Machine registry surface (M8) — own module, app.ts must not grow.
    registerMachinesRoutes(r, {
      auth: this.auth,
      stateDir: this.stateDir,
      manager: this.machines,
      localDto: () => this.localMachineDto(),
      onReloaded: () => {
        this.fleetCache = null;
      },
    });

    // Per-tool adapter surfaces (usage/account/harness) + the manage-agent API.
    registerToolsRoutes(r, {
      adapters: this.adaptersById,
      store: this.store,
      harnessCtx: () => this.harnessCtx(),
      gate: (req, res, action, opts) => this.gate(req, res, action, opts),
    });
    // Harness file editor + '내 커스텀' + profiles + prefs + statusbar (M9) —
    // own modules, app.ts must not grow (contract §0).
    registerHarnessRoutes(r, {
      adapters: this.adaptersById,
      store: this.store,
      engine: this.harnessEngine,
      harnessCtx: () => this.harnessCtx(),
      projectRoot: () => process.cwd(),
      gate: (req, res, action, opts) => this.gate(req, res, action, opts),
    });
    registerProfilesRoutes(r, {
      auth: this.auth,
      store: this.store,
      registry: this.profiles,
      adapters: this.adaptersById,
      liveSessionCount: (toolId) =>
        this.registry.all().filter((s) => s.adapterId === toolId && s.running).length,
      gate: (req, res, action, opts) => this.gate(req, res, action, opts),
    });
    registerPrefsRoutes(r, { auth: this.auth, store: this.store, stateDir: this.stateDir });
    registerSessionStatusRoutes(r, { statuses: this.sessionStatuses });
    registerAgentRoutes(r, {
      auth: this.auth,
      store: this.store,
      permissions: this.permissions,
      confirmations: this.confirmations,
      manageAgent: this.manageAgent,
      stateDir: this.stateDir,
      enabled: this.agentEnabled,
      disabledStatus: () => this.disabledAgentStatus(),
      resolveConfirmation: (req, res, id, verb) => this.resolveConfirmation(req, res, id, verb),
    });
  }

  /** Context handed to adapter account/harness surfaces (fixture-able home). */
  private harnessCtx(): HarnessContext {
    return { home: this.opts.collectHome ?? os.homedir() };
  }

  /** Live count of agent-origin confirmation cards (the approval inbox). */
  private agentPendingCount(): number {
    return this.confirmations.list().filter((p) => p.origin?.kind === 'manage-agent').length;
  }

  /** Status DTO when the agent is disabled — honest, never a fabricated green. */
  private disabledAgentStatus(): AgentStatusDto {
    return {
      state: 'disabled',
      enabled: false,
      brain: { id: this.agentBrain.id, availability: 'unverified' },
      caps: { ...this.agentCaps },
      budget: { spentUsd: null, capUsd: this.agentCaps.maxBudgetUsdPerDay },
      pendingApprovals: this.agentPendingCount(),
    };
  }

  /**
   * Spawn on behalf of an approved/autonomous agent proposal: same validation
   * (`buildSpawnCommand`) and same execution path as the transport route, with
   * the actor pinned to `'agent'`.
   */
  private async spawnFromAgent(request: AgentSpawnRequest): Promise<GateResult> {
    const body: z.infer<typeof SpawnBodySchema> = { ...request };
    const spec = this.buildSpawnCommand(body);
    if ('error' in spec) return { status: 400, body: { code: spec.error, ...(spec.extra ?? {}) } };
    // Agent spawns resolve the ACTIVE profile too (same env path as the route).
    const profile = this.resolveSpawnProfile(
      body.adapterId,
      body.profile,
      body.machine ?? LOCAL_MACHINE_ID,
    );
    if ('error' in profile) {
      return { status: profile.status, body: { code: profile.error, ...(profile.extra ?? {}) } };
    }
    return this.spawnSession(body, spec, 'agent', profile);
  }

  /**
   * Resolve the EFFECTIVE profile for a spawn (M9 D2): the body's `profile`
   * override, else `active[toolId]`, else `default`. `default` = the real
   * home, env untouched. A non-default profile needs the adapter's
   * `configHomeEnvVars` (else 422 profile_unsupported — agy has no verified
   * isolation env) and a LOCAL machine (configHome paths are local in v1).
   * The configHome is a POINTER: its contents are never read or created here.
   */
  private resolveSpawnProfile(
    adapterId: string,
    requested: string | undefined,
    machineId: string,
  ):
    | { profileId: string; env: Record<string, string> }
    | { status: number; error: string; extra?: Record<string, unknown> } {
    const effective = requested ?? this.profiles.activeOf(adapterId);
    if (effective === DEFAULT_PROFILE_ID) return { profileId: DEFAULT_PROFILE_ID, env: {} };
    const profile = this.profiles.find(adapterId, effective);
    if (!profile) {
      return {
        status: 400,
        error: 'unknown_profile',
        extra: { toolId: adapterId, profileId: effective },
      };
    }
    const vars = this.adaptersById.get(adapterId)?.configHomeEnvVars ?? [];
    if (vars.length === 0) {
      return { status: 422, error: 'profile_unsupported', extra: { toolId: adapterId } };
    }
    if (machineId !== LOCAL_MACHINE_ID) {
      return {
        status: 422,
        error: 'profile_machine_unsupported',
        extra: { toolId: adapterId, machine: machineId },
      };
    }
    return {
      profileId: effective,
      env: Object.fromEntries(vars.map((v) => [v, profile.configHome])),
    };
  }

  // -------------------------------------------------------------------------
  // actions (invoked directly or via an approved confirmation)
  // -------------------------------------------------------------------------

  private async deliverDirective(
    sessionId: string,
    text: string,
    actor: Actor,
  ): Promise<GateResult> {
    const directiveId = crypto.randomUUID();
    const masked = maskSecrets(text);
    const session = this.registry.get(sessionId);
    const linkUp =
      session?.machine === LOCAL_MACHINE_ID
        ? this.paneld.connected
        : this.machines.get(session?.machine ?? '')?.state === 'connected';
    if (session && session.running && linkUp) {
      const adapter = this.adaptersById.get(session.adapterId);
      if (adapter) {
        const discovered: DiscoveredSession = {
          id: session.id,
          tool: session.adapterId,
          live: true,
          cwd: session.cwd,
        };
        const driver = adapter.driverFor(discovered, {
          inject: async (bytes) => {
            // Same driver path for every machine — only the link differs.
            if (session.machine === LOCAL_MACHINE_ID) {
              await this.paneld.ensureAttached(session.sid);
              this.paneld.input(session.sid, Buffer.from(bytes));
            } else {
              await this.machines.ensureAttached(session.machine, session.sid);
              this.machines.input(session.machine, session.sid, Buffer.from(bytes));
            }
          },
        });
        if (driver) {
          try {
            await driver.sendText({ text, submit: true });
          } catch {
            // Live delivery failed (host raced away, driver error) — fall back
            // to the queued contract instead of losing the directive.
            this.store.append('directive.queued', {
              sessionId,
              actor,
              payload: { directiveId, text: masked, fallback: 'driver_failed' },
            });
            return { status: 202, body: { queued: true, directiveId } };
          }
          this.store.append('directive.delivered', {
            sessionId,
            actor,
            payload: { directiveId, text: masked, method: 'driver' },
          });
          return { status: 200, body: { delivered: true, directiveId } };
        }
      }
    }
    // Not paneld-owned. If it's a LOCAL discovered session running inside a tmux
    // pane, deliver via non-adopting `tmux send-keys` — this reaches the live
    // TUI (like typing) WITHOUT attaching a client (no resize/redraw conflict on
    // the user's terminal). Resolvable only for local sessions with a live pid.
    const bin = tmux.resolveTmuxBin();
    if (bin) {
      const target = await this.localTmuxTargetFor(sessionId, bin);
      if (target) {
        try {
          await tmux.sendText(bin, target, text);
          this.store.append('directive.delivered', {
            sessionId,
            actor,
            payload: { directiveId, text: masked, method: 'tmux-sendkeys' },
          });
          return { status: 200, body: { delivered: true, directiveId } };
        } catch {
          // send-keys failed (pane raced away) — fall through to the honest queue.
        }
      }
    }
    // Not paneld-owned and not a resolvable tmux pane: queue it. Delivery-at-next
    // -turn for hook-only sessions is a later milestone; the event IS the contract.
    this.store.append('directive.queued', {
      sessionId,
      actor,
      payload: { directiveId, text: masked },
    });
    return { status: 202, body: { queued: true, directiveId } };
  }

  /**
   * The tmux pane target (`pane_id`) for a LOCAL discovered (non-paneld-owned)
   * session with a live pid, or null. Remote sessions and sessions without a
   * resolvable local tmux pane return null so the caller stays honest (queues,
   * never fabricates a delivery).
   */
  private async localTmuxTargetFor(sessionId: string, bin: string): Promise<string | null> {
    let snap: FleetSnapshot;
    try {
      snap = await this.fleetSnapshot();
    } catch {
      return null;
    }
    const s = snap.sessions.find(
      (x) =>
        x.id === sessionId &&
        x.origin === 'adapter' &&
        (x.machine ?? LOCAL_MACHINE_ID) === LOCAL_MACHINE_ID &&
        typeof x.pid === 'number',
    );
    if (s?.pid === undefined) return null;
    return tmux.resolvePaneByPid(bin, s.pid);
  }

  private buildSpawnCommand(
    body: z.infer<typeof SpawnBodySchema>,
  ): { cmd: string; args: string[] } | { error: string; extra?: Record<string, unknown> } {
    const adapter = this.adaptersById.get(body.adapterId);
    if (!adapter) return { error: 'unknown_adapter', extra: { adapterId: body.adapterId } };
    if (body.adapterId === 'claude') {
      return {
        cmd: this.opts.claudeCmd ?? 'claude',
        args: [
          ...(body.model !== undefined ? ['--model', body.model] : []),
          ...(body.permissionMode !== undefined ? ['--permission-mode', body.permissionMode] : []),
        ],
      };
    }
    if (body.adapterId === 'codex') {
      // Per the M7 contract: `-m` model, `-s` sandbox-mode via permissionMode.
      return {
        cmd: this.opts.codexCmd ?? 'codex',
        args: [
          ...(body.model !== undefined ? ['-m', body.model] : []),
          ...(body.permissionMode !== undefined ? ['-s', body.permissionMode] : []),
        ],
      };
    }
    if (body.adapterId === 'agy') {
      // agy has no single permission-mode flag: 'default' is the no-flag
      // behaviour and the two others map to dedicated flags (adapter docs).
      let permissionArgs: string[];
      switch (body.permissionMode) {
        case undefined:
        case 'default':
          permissionArgs = [];
          break;
        case 'skip-permissions':
          permissionArgs = ['--dangerously-skip-permissions'];
          break;
        case 'sandbox':
          permissionArgs = ['--sandbox'];
          break;
        default:
          return { error: 'bad_request', extra: { param: 'permissionMode' } };
      }
      return {
        cmd: this.opts.agyCmd ?? 'agy',
        args: [...(body.model !== undefined ? ['--model', body.model] : []), ...permissionArgs],
      };
    }
    if (body.adapterId === 'generic-pty') {
      if (body.cmd === undefined) return { error: 'bad_request', extra: { param: 'cmd' } };
      const allowlist = this.opts.spawnAllowlist ?? DEFAULT_SPAWN_ALLOWLIST;
      if (!allowlist.includes(path.basename(body.cmd))) {
        return { error: 'cmd_not_allowed', extra: { cmd: path.basename(body.cmd) } };
      }
      return { cmd: body.cmd, args: body.args ?? [] };
    }
    // Only the built-in tools are spawnable in v1 — honest, not silent.
    return { error: 'spawn_unsupported', extra: { adapterId: body.adapterId } };
  }

  private async spawnSession(
    body: z.infer<typeof SpawnBodySchema>,
    command: { cmd: string; args: string[] },
    actor: Actor,
    profile: { profileId: string; env: Record<string, string> } = {
      profileId: DEFAULT_PROFILE_ID,
      env: {},
    },
  ): Promise<GateResult> {
    const id = crypto.randomUUID();
    const machineId = body.machine ?? LOCAL_MACHINE_ID;
    const label = body.label ?? `${body.adapterId}-${id.slice(0, 8)}`;
    const spec: SpawnSpec = {
      cmd: command.cmd,
      args: command.args,
      cwd: body.cwd,
      // Profile isolation (M9 D2): only the adapter's config-home vars are
      // set — SpawnSpec.env layers over the daemon's process.env, nothing is
      // unset and no credentials are bridged.
      env: { ...profile.env },
      cols: body.cols ?? 120,
      rows: body.rows ?? 32,
      label,
      meta: { terminullId: id, adapterId: body.adapterId, label, cwd: body.cwd },
    };
    let spawned: { sid: number; pid: number };
    try {
      spawned =
        machineId === LOCAL_MACHINE_ID
          ? await this.paneld.spawn(spec)
          : await this.machines.spawn(machineId, spec);
    } catch (e) {
      if (e instanceof HostUnavailableError) {
        return { status: 503, body: { code: 'host_unavailable' } };
      }
      if (e instanceof UnknownMachineError) {
        return { status: 400, body: { code: 'unknown_machine', machine: machineId } };
      }
      if (e instanceof MachineUnavailableError) {
        // The machine can go stale between the route check and execution
        // (e.g. an approved confirmation running later) — honest either way.
        return {
          status: 503,
          body: { code: 'machine_unavailable', machine: machineId, state: e.state },
        };
      }
      if (e instanceof HostRequestError) {
        // Carried-over M8 fix: preserve the remote daemon's error detail
        // end-to-end (masked) — a bare hostCode buried real failure causes.
        return {
          status: 502,
          body: {
            code: 'spawn_failed',
            hostCode: e.hostCode,
            detail: maskSecrets(e.hostMessage),
          },
        };
      }
      throw e;
    }
    this.registry.add({
      id,
      sid: spawned.sid,
      adapterId: body.adapterId,
      cwd: body.cwd,
      label,
      running: true,
      pid: spawned.pid,
      createdAt: Date.now(),
      machine: machineId,
    });
    this.fleetCache = null; // the new session must be visible immediately
    this.store.append('session.start', {
      sessionId: id,
      tool: body.adapterId,
      actor,
      payload: {
        sid: spawned.sid,
        pid: spawned.pid,
        cwd: body.cwd,
        label,
        adapterId: body.adapterId,
        machine: machineId,
        profile: profile.profileId,
      },
    });
    return {
      status: 201,
      body: {
        sessionId: id,
        sid: spawned.sid,
        pid: spawned.pid,
        label,
        machine: machineId,
        profile: profile.profileId,
      },
    };
  }

  private async killSession(session: ServerSession): Promise<GateResult> {
    if (!session.running) {
      return { status: 200, body: { deleted: true, exited: true, alreadyExited: true } };
    }
    const local = session.machine === LOCAL_MACHINE_ID;
    if (local && !this.paneld.connected) {
      return { status: 503, body: { code: 'host_unavailable' } };
    }
    const kill = (signal: string): void => {
      if (local) this.paneld.kill(session.sid, signal);
      else this.machines.kill(session.machine, session.sid, signal);
    };
    try {
      kill('SIGTERM');
      let exited = await this.waitForExit(session, 2000);
      if (!exited) {
        kill('SIGKILL');
        exited = await this.waitForExit(session, 2000);
      }
      this.fleetCache = null;
      // session.end is minted by the daemon-exit handler (exactly once); the
      // response reports what ACTUALLY happened, kill claims included.
      return { status: 200, body: { deleted: true, exited } };
    } catch (e) {
      if (e instanceof MachineUnavailableError) {
        return {
          status: 503,
          body: { code: 'machine_unavailable', machine: session.machine, state: e.state },
        };
      }
      throw e;
    }
  }

  private waitForExit(session: ServerSession, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const poll = (): void => {
        if (!session.running) {
          resolve(true);
          return;
        }
        if (Date.now() > deadline) {
          resolve(false);
          return;
        }
        setTimeout(poll, 50);
      };
      poll();
    });
  }

  private async readTranscript(
    res: http.ServerResponse,
    sessionId: string,
    cursorRaw: string | null,
  ): Promise<void> {
    // paneld-owned sessions have no tool-native transcript in v1 — honest.
    if (this.registry.get(sessionId)) {
      json(res, 200, { supported: false, reason: 'no_transcript' });
      return;
    }
    const snap = await this.fleetSnapshot();
    const session = snap.sessions.find((s) => s.origin === 'adapter' && s.id === sessionId);
    if (!session) {
      fail(res, 404, 'not_found');
      return;
    }
    // Remote adapter sessions have no transcript window in v1 — honest refusal
    // instead of reading a local path that describes a different machine.
    if (session.machine !== undefined && session.machine !== LOCAL_MACHINE_ID) {
      json(res, 200, { supported: false, reason: 'remote_transcript' });
      return;
    }
    const adapter = this.adaptersById.get(session.tool);
    if (!adapter?.parser || !session.transcriptRef) {
      json(res, 200, { supported: false, reason: 'parser_unavailable' });
      return;
    }
    let cursor: { offset: number } | undefined;
    if (cursorRaw !== null) {
      const offset = Number(cursorRaw);
      if (!Number.isInteger(offset) || offset < 0) {
        fail(res, 400, 'bad_request', { param: 'cursor' });
        return;
      }
      cursor = { offset };
    }
    try {
      const window = await adapter.parser.readWindow(session.transcriptRef, cursor);
      json(res, 200, { supported: true, ...window });
    } catch {
      fail(res, 502, 'transcript_read_failed');
    }
  }

  private async resolveConfirmation(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    id: string,
    verb: 'approve' | 'reject',
  ): Promise<void> {
    // Only a POSITIVELY-credentialed user resolves confirmations — the entire
    // point of the queue is that agents cannot approve themselves.
    if (this.auth.actorOf(req) !== 'user') {
      fail(res, 403, 'user_required');
      return;
    }
    const pending = this.confirmations.get(id);
    if (!pending) {
      fail(res, 404, 'not_found');
      return;
    }
    this.confirmations.remove(id);
    // Agent-origin cards get the extra `agent.action` audit steps HERE (the
    // shared resolve path), so /api/agent/approvals/:id/resolve and the plain
    // /api/confirmations routes produce the identical chain.
    const audit =
      pending.origin !== undefined
        ? {
            proposalId: pending.origin.proposalId,
            turnId: pending.origin.turnId,
            actionKind: PERMISSION_TO_KIND[pending.action] ?? ('unknown' as ProposedActionKind),
            permissionAction: pending.action,
            confirmationId: id,
            ...(pending.origin.reason !== undefined ? { reason: pending.origin.reason } : {}),
          }
        : null;
    if (verb === 'reject') {
      this.store.append('confirmation.rejected', {
        actor: 'user',
        ...(pending.sessionId !== undefined ? { sessionId: pending.sessionId } : {}),
        payload: { confirmationId: id, action: pending.action },
      });
      if (audit) this.agentActions.emitPhase({ ...audit, phase: 'denied', resultCode: 'rejected' });
      json(res, 200, { rejected: true, confirmationId: id, action: pending.action });
      return;
    }
    this.store.append('confirmation.approved', {
      actor: 'user',
      ...(pending.sessionId !== undefined ? { sessionId: pending.sessionId } : {}),
      payload: { confirmationId: id, action: pending.action },
    });
    if (audit) this.agentActions.emitPhase({ ...audit, phase: 'approved' });
    let result: GateResult;
    try {
      result = await pending.execute();
    } catch (e) {
      if (audit) {
        this.agentActions.emitPhase({ ...audit, phase: 'failed', resultCode: 'internal_error' });
      }
      throw e;
    }
    if (audit) {
      this.agentActions.emitPhase({
        ...audit,
        phase: result.status < 400 ? 'executed' : 'failed',
        resultCode: resultCodeOf(result),
      });
    }
    json(res, 200, {
      approved: true,
      confirmationId: id,
      action: pending.action,
      resultStatus: result.status,
      result: result.body,
    });
  }

  // -------------------------------------------------------------------------
  // websockets
  // -------------------------------------------------------------------------

  private onWsEvents(ws: WebSocket): void {
    const hello: PanelHello = { t: 'hello', proto: PANEL_PROTO_VERSION, seq: this.store.seq };
    ws.send(JSON.stringify(hello));
    const unsubscribe = this.store.subscribe((event) => {
      if (ws.readyState === ws.OPEN) {
        const msg: PanelEvent = { t: 'event', event };
        ws.send(JSON.stringify(msg));
      }
    });
    ws.on('close', unsubscribe);
    ws.on('error', () => ws.terminate());
  }

  private async onWsPty(ws: WebSocket, url: URL, actor: RequestActor): Promise<void> {
    const sessionId = url.searchParams.get('sid') ?? '';
    const mode = url.searchParams.get('mode') === 'rw' ? 'rw' : 'ro';
    const session = this.registry.get(sessionId);
    if (!session) {
      ws.close(4404, 'not_found');
      return;
    }
    if (!session.running) {
      ws.close(4410, 'session_ended');
      return;
    }
    // Raw PTY input bypasses every driver safety check, so read-write needs a
    // positively-credentialed user; read-only viewing follows normal auth.
    if (mode === 'rw' && actor !== 'user') {
      ws.close(4403, 'user_required');
      return;
    }
    const readOnly = mode === 'ro';
    let attachment;
    try {
      // A remote session attaches over ITS machine's transport (fresh relay
      // child per viewer); a stale machine is an honest 1011 refusal.
      attachment =
        session.machine === LOCAL_MACHINE_ID
          ? await this.paneld.openAttachment(session.sid, { sinceSeq: 0, readOnly })
          : await this.machines.openAttachment(session.machine, session.sid, {
              sinceSeq: 0,
              readOnly,
            });
    } catch {
      ws.close(
        1011,
        session.machine === LOCAL_MACHINE_ID ? 'host_unavailable' : 'machine_unavailable',
      );
      return;
    }
    // Carried-over M8 fix: the viewer may have left WHILE the attachment was
    // dialing (remote attach = a fresh relay child). The ws 'close' handler
    // below is registered too late for that race — reap the child here or it
    // orphans until the machine link itself dies.
    if (ws.readyState !== ws.OPEN) {
      attachment.close();
      return;
    }
    const attached: PtyAttached = {
      t: 'attached',
      fromSeq: attachment.fromSeq,
      headSeq: attachment.headSeq,
      gap: attachment.gap,
      readOnly,
    };
    ws.send(JSON.stringify(attached));
    attachment.onOut((data) => {
      if (ws.readyState === ws.OPEN) ws.send(data, { binary: true });
    });
    attachment.onExit(() => ws.close(1000, 'session_exit'));
    attachment.onClose(() => ws.close(1011, 'host_connection_lost'));
    const sendError = (code: string): void => {
      if (ws.readyState === ws.OPEN) {
        const err: PtyError = { t: 'error', code };
        ws.send(JSON.stringify(err));
      }
    };
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        if (readOnly) {
          sendError('read_only');
          return;
        }
        attachment.write(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(data));
      } catch {
        sendError('bad_message');
        return;
      }
      const msg = PtyClientMessageSchema.safeParse(parsed);
      if (!msg.success) {
        sendError('bad_message');
        return;
      }
      if (msg.data.t === 'resize') {
        if (readOnly) {
          sendError('read_only');
          return;
        }
        attachment.resize(msg.data.cols, msg.data.rows);
      }
    });
    ws.on('close', () => attachment.close());
    ws.on('error', () => ws.terminate());
  }
}

/** Build a server (no side effects beyond state-dir bootstrap; call `listen`). */
export function createTerminullServer(opts: ServerOptions): TerminullServer {
  return new TerminullServer(opts);
}
