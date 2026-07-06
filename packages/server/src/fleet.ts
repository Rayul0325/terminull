/**
 * Fleet collection — one normalized view of every session Terminull can see:
 * the registered adapters' discovered sessions (claude registry/transcripts,
 * etc.) plus the paneld-owned sessions the server spawned itself.
 *
 * Honesty rules: a collector failure NEVER silently drops that adapter — the
 * per-adapter status carries `error:'collector_failed'`; liveness is whatever
 * the collector could verify (false when unverifiable); paneld sessions carry
 * `origin:'paneld'` so clients can tell surface-of-truth apart.
 */
import type { CollectContext, DiscoveredSession, ToolAdapter } from '@terminull/adapter-sdk';
import {
  LOCAL_MACHINE_ID,
  type Collected,
  type Envelope,
  type MachineStateDto,
  type SessionSummary,
} from '@terminull/shared';
import type { SessionRegistry } from './sessions.js';

/** Per-adapter collection status (errors isolated, never dropped silently). */
export interface AdapterFleetStatus {
  adapterId: string;
  ok: boolean;
  /** Machine code; present iff `ok` is false. */
  error?: 'collector_failed' | 'unreachable';
  sessions: number;
  /** Machine this status was collected on. Absent = 'local' (M8, additive). */
  machine?: string;
}

/** A fleet entry: a discovered session plus its provenance. */
export interface FleetSession extends DiscoveredSession {
  origin: 'adapter' | 'paneld';
  /** Present for paneld-owned sessions: the id used by /api/sessions, /pty. */
  serverSessionId?: string;
  /** Machine this session lives on. Absent = 'local' (M8, additive). */
  machine?: string;
  /**
   * What this session is doing right now, derived from the server's in-memory
   * recent-event window (never a disk re-parse). `toolName` is the RAW tool
   * name (e.g. 'Bash') — the web maps it to a localized label; `summary` is a
   * short human string (a bash description, a file path). Absent = honestly
   * unknown; the client renders "확인 중"/"—" rather than a fabricated value.
   */
  lastActivity?: { toolName?: string; summary?: string };
}

/** The slice of a recent in-memory event needed to derive `lastActivity`. */
type RecentEvent = Pick<Envelope, 'sessionId' | 'payload'>;

/** Read a non-empty string field from an event's opaque payload, or undefined. */
function payloadStr(payload: unknown, key: string): string | undefined {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const val = (payload as Record<string, unknown>)[key];
    if (typeof val === 'string' && val.length > 0) return val;
  }
  return undefined;
}

/**
 * Derive a session's "what is it doing right now" from the server's in-memory
 * recent-event window. Scans newest-first for the most recent event belonging
 * to `sessionId` that carries a tool-activity signal (`toolName`, or a summary
 * string), and returns the raw tool name plus an optional short summary.
 *
 * Returns `undefined` when no such event exists — an HONEST absent, never a
 * fabricated placeholder. `recentEvents` is expected in append (oldest-first)
 * order, matching `EventStore.inbox`; the newest matching event wins.
 */
export function lastActivityForSession(
  recentEvents: readonly RecentEvent[],
  sessionId: string,
): { toolName?: string; summary?: string } | undefined {
  for (let i = recentEvents.length - 1; i >= 0; i--) {
    const ev = recentEvents[i];
    if (!ev || ev.sessionId !== sessionId) continue;
    const toolName = payloadStr(ev.payload, 'toolName');
    // Prefer an explicit summary; fall back to the classic PostToolUse human
    // strings (a bash description, a file path).
    const summary =
      payloadStr(ev.payload, 'summary') ??
      payloadStr(ev.payload, 'description') ??
      payloadStr(ev.payload, 'file');
    if (toolName === undefined && summary === undefined) continue;
    return {
      ...(toolName !== undefined ? { toolName } : {}),
      ...(summary !== undefined ? { summary } : {}),
    };
  }
  return undefined;
}

/** The `GET /api/fleet` payload. */
export interface FleetSnapshot {
  generatedAt: number;
  adapters: AdapterFleetStatus[];
  sessions: FleetSession[];
  /**
   * Per-machine connection state (M8, additive — absent before the machine
   * registry is wired). Stale machines appear HERE with `lastSeenAt`; their
   * possibly-dead sessions are excluded from `sessions` rather than ghosted.
   */
  machines?: MachineStateDto[];
}

/** Collect from every LOCAL adapter (isolated) + local paneld registry sessions. */
export async function collectFleet(
  adapters: Map<string, ToolAdapter>,
  registry: SessionRegistry,
  ctx: CollectContext,
  // Optional in-memory recent-event window (e.g. `EventStore.inbox`). When
  // provided, each local session is enriched with `lastActivity` derived from
  // its most recent event; absent/empty leaves every session's `lastActivity`
  // undefined (honest absent). Never re-parses transcripts from disk.
  recentEvents: readonly RecentEvent[] = [],
): Promise<FleetSnapshot> {
  const statuses: AdapterFleetStatus[] = [];
  const sessions: FleetSession[] = [];

  await Promise.all(
    [...adapters.values()].map(async (adapter) => {
      try {
        const found = await adapter.collector.collect(ctx);
        statuses.push({
          adapterId: adapter.id,
          ok: true,
          sessions: found.length,
          machine: LOCAL_MACHINE_ID,
        });
        for (const s of found)
          sessions.push({ ...s, origin: 'adapter', machine: LOCAL_MACHINE_ID });
      } catch {
        // Isolation: one broken collector must not hide the others' sessions,
        // and its own absence must be visible, not silent.
        statuses.push({
          adapterId: adapter.id,
          ok: false,
          error: 'collector_failed',
          sessions: 0,
          machine: LOCAL_MACHINE_ID,
        });
      }
    }),
  );

  for (const s of registry.all()) {
    // Remote paneld sessions are merged from their machine's live `list` (see
    // remotePaneldFleetSessions) — including the registry copy here would
    // double-report them and ghost sessions of stale machines.
    if (s.machine !== LOCAL_MACHINE_ID) continue;
    sessions.push({
      id: s.id,
      tool: s.adapterId,
      cwd: s.cwd,
      live: s.running,
      title: s.label,
      updatedAt: s.createdAt,
      origin: 'paneld',
      serverSessionId: s.id,
      machine: LOCAL_MACHINE_ID,
    });
  }

  // Enrich with "what is it doing right now" from the in-memory event window.
  // Sessions with no matching recent event keep `lastActivity` undefined — the
  // client renders "확인 중"/"—", never a fabricated value.
  if (recentEvents.length > 0) {
    for (const s of sessions) {
      const activity = lastActivityForSession(recentEvents, s.id);
      if (activity !== undefined) s.lastActivity = activity;
    }
  }

  sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return { generatedAt: Date.now(), adapters: statuses, sessions };
}

/**
 * Map one CONNECTED machine's live `list` reply into fleet sessions. Sessions
 * the registry knows (spawned through this server) keep their public id and
 * `serverSessionId`; foreign sessions get a synthetic per-machine id and no
 * server id (they are visible, but not addressable via /pty — honest view).
 */
export function remotePaneldFleetSessions(
  machineId: string,
  summaries: SessionSummary[],
  registry: SessionRegistry,
): FleetSession[] {
  return summaries.map((s) => {
    const known = registry.getBySid(s.sid, machineId);
    const label = s.label ?? known?.label;
    const cwd = known?.cwd;
    return {
      id: known?.id ?? `${machineId}:${s.sid}`,
      tool: known?.adapterId ?? s.cmd,
      live: s.running,
      ...(cwd !== undefined ? { cwd } : {}),
      ...(label !== undefined ? { title: label } : {}),
      ...(known !== undefined ? { updatedAt: known.createdAt } : {}),
      origin: 'paneld' as const,
      ...(known !== undefined ? { serverSessionId: known.id } : {}),
      machine: machineId,
    };
  });
}

/** Map one machine's `collected` reply into fleet statuses + sessions. */
export function remoteCollectedToFleet(
  machineId: string,
  collected: Collected,
): { statuses: AdapterFleetStatus[]; sessions: FleetSession[] } {
  return {
    statuses: collected.adapters.map((a) => ({
      adapterId: a.adapterId,
      ok: a.ok,
      ...(a.error !== undefined ? { error: a.error } : {}),
      sessions: a.sessions,
      machine: machineId,
    })),
    sessions: collected.sessions.map((s) => ({
      ...s,
      origin: 'adapter' as const,
      machine: machineId,
    })),
  };
}

/** The honest per-machine status when a remote gather step failed outright. */
export function unreachableStatus(machineId: string): AdapterFleetStatus {
  return { adapterId: '*', ok: false, error: 'unreachable', sessions: 0, machine: machineId };
}
