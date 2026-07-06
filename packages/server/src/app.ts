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
  NotPostableError,
  PermissionSettings,
  maskSecrets,
} from '@terminull/core';
import { PluginHost, type DiscoveredSession, type ToolAdapter } from '@terminull/adapter-sdk';
import {
  PANEL_PROTO_VERSION,
  PtyClientMessageSchema,
  type Actor,
  type PanelEvent,
  type PanelHello,
  type PtyAttached,
  type PtyError,
  type SpawnSpec,
} from '@terminull/shared';
import * as claudePlugin from '@terminull/adapter-claude';
import * as genericPlugin from '@terminull/adapter-generic';
import { Auth, TOKEN_COOKIE, originOk, type RequestActor } from './auth.js';
import { ConfirmationQueue, type GateResult } from './confirmations.js';
import { removeDiscovery, writeDiscovery } from './discovery.js';
import { collectFleet, type FleetSnapshot } from './fleet.js';
import { BodyError, Router, fail, json, maskDeep, readJsonBody } from './http-util.js';
import { HostRequestError, HostUnavailableError, PaneldClient } from './paneld-client.js';
import { SessionRegistry, type ServerSession } from './sessions.js';

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
  /** Generic-adapter spawn allowlist (basenames). */
  spawnAllowlist?: string[];
  /** Fleet snapshot cache TTL in ms (default 2000). */
  fleetTtlMs?: number;
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
  readonly pluginHost: PluginHost;

  private readonly adaptersById = new Map<string, ToolAdapter>();
  private readonly router = new Router();
  private readonly httpServer: http.Server;
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly version = readServerVersion();
  private readonly startedAt = Date.now();
  private readonly opts: ServerOptions;
  private fleetCache: { at: number; snap: FleetSnapshot } | null = null;
  private boundPort: number | null = null;

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
      },
      onDown: () => {
        this.store.append('host.down', { payload: {} });
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
      if (!match) {
        fail(res, 404, 'not_found');
        return;
      }
      await match.handler(req, res, match.params, url);
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
    this.fleetCache = { at: Date.now(), snap };
    return snap;
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
      await this.gate(req, res, 'session.spawn', {
        params: { adapterId: body.data.adapterId, cwd: body.data.cwd, cmd: spec.cmd },
        execute: (actor) => this.spawnSession(body.data, spec, actor),
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

    r.add('GET', '/', (_req, res) => {
      let html: string;
      try {
        html = fs.readFileSync(
          fileURLToPath(new URL('./smoke/index.html', import.meta.url)),
          'utf8',
        );
      } catch {
        fail(res, 500, 'smoke_page_missing');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    });
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
    if (session && session.running && this.paneld.connected) {
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
            await this.paneld.ensureAttached(session.sid);
            this.paneld.input(session.sid, Buffer.from(bytes));
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
    // Not a paneld-owned live session: queue it. Delivery-at-next-turn comes
    // with the hook harness (a later milestone); the event IS the contract.
    this.store.append('directive.queued', {
      sessionId,
      actor,
      payload: { directiveId, text: masked },
    });
    return { status: 202, body: { queued: true, directiveId } };
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
    if (body.adapterId === 'generic-pty') {
      if (body.cmd === undefined) return { error: 'bad_request', extra: { param: 'cmd' } };
      const allowlist = this.opts.spawnAllowlist ?? DEFAULT_SPAWN_ALLOWLIST;
      if (!allowlist.includes(path.basename(body.cmd))) {
        return { error: 'cmd_not_allowed', extra: { cmd: path.basename(body.cmd) } };
      }
      return { cmd: body.cmd, args: body.args ?? [] };
    }
    // Only the two built-ins are spawnable in v1 — honest, not silent.
    return { error: 'spawn_unsupported', extra: { adapterId: body.adapterId } };
  }

  private async spawnSession(
    body: z.infer<typeof SpawnBodySchema>,
    command: { cmd: string; args: string[] },
    actor: Actor,
  ): Promise<GateResult> {
    const id = crypto.randomUUID();
    const label = body.label ?? `${body.adapterId}-${id.slice(0, 8)}`;
    const spec: SpawnSpec = {
      cmd: command.cmd,
      args: command.args,
      cwd: body.cwd,
      env: {},
      cols: body.cols ?? 120,
      rows: body.rows ?? 32,
      label,
      meta: { terminullId: id, adapterId: body.adapterId, label, cwd: body.cwd },
    };
    let spawned: { sid: number; pid: number };
    try {
      spawned = await this.paneld.spawn(spec);
    } catch (e) {
      if (e instanceof HostUnavailableError) {
        return { status: 503, body: { code: 'host_unavailable' } };
      }
      if (e instanceof HostRequestError) {
        return { status: 502, body: { code: 'spawn_failed', hostCode: e.hostCode } };
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
      },
    });
    return {
      status: 201,
      body: { sessionId: id, sid: spawned.sid, pid: spawned.pid, label },
    };
  }

  private async killSession(session: ServerSession): Promise<GateResult> {
    if (!session.running) {
      return { status: 200, body: { deleted: true, exited: true, alreadyExited: true } };
    }
    if (!this.paneld.connected) return { status: 503, body: { code: 'host_unavailable' } };
    this.paneld.kill(session.sid, 'SIGTERM');
    let exited = await this.waitForExit(session, 2000);
    if (!exited) {
      this.paneld.kill(session.sid, 'SIGKILL');
      exited = await this.waitForExit(session, 2000);
    }
    this.fleetCache = null;
    // session.end is minted by the daemon-exit handler (exactly once); the
    // response reports what ACTUALLY happened, kill claims included.
    return { status: 200, body: { deleted: true, exited } };
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
    if (verb === 'reject') {
      this.store.append('confirmation.rejected', {
        actor: 'user',
        ...(pending.sessionId !== undefined ? { sessionId: pending.sessionId } : {}),
        payload: { confirmationId: id, action: pending.action },
      });
      json(res, 200, { rejected: true, confirmationId: id, action: pending.action });
      return;
    }
    this.store.append('confirmation.approved', {
      actor: 'user',
      ...(pending.sessionId !== undefined ? { sessionId: pending.sessionId } : {}),
      payload: { confirmationId: id, action: pending.action },
    });
    const result = await pending.execute();
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
      attachment = await this.paneld.openAttachment(session.sid, { sinceSeq: 0, readOnly });
    } catch {
      ws.close(1011, 'host_unavailable');
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
