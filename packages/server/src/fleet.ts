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
