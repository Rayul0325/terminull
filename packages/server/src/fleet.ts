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
import type { SessionRegistry } from './sessions.js';

/** Per-adapter collection status (errors isolated, never dropped silently). */
export interface AdapterFleetStatus {
  adapterId: string;
  ok: boolean;
  /** Machine code; present iff `ok` is false. */
  error?: 'collector_failed';
  sessions: number;
}

/** A fleet entry: a discovered session plus its provenance. */
export interface FleetSession extends DiscoveredSession {
  origin: 'adapter' | 'paneld';
  /** Present for paneld-owned sessions: the id used by /api/sessions, /pty. */
  serverSessionId?: string;
}

/** The `GET /api/fleet` payload. */
export interface FleetSnapshot {
  generatedAt: number;
  adapters: AdapterFleetStatus[];
  sessions: FleetSession[];
}

/** Collect from every adapter (isolated) and merge paneld registry sessions. */
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
        statuses.push({ adapterId: adapter.id, ok: true, sessions: found.length });
        for (const s of found) sessions.push({ ...s, origin: 'adapter' });
      } catch {
        // Isolation: one broken collector must not hide the others' sessions,
        // and its own absence must be visible, not silent.
        statuses.push({
          adapterId: adapter.id,
          ok: false,
          error: 'collector_failed',
          sessions: 0,
        });
      }
    }),
  );

  for (const s of registry.all()) {
    sessions.push({
      id: s.id,
      tool: s.adapterId,
      cwd: s.cwd,
      live: s.running,
      title: s.label,
      updatedAt: s.createdAt,
      origin: 'paneld',
      serverSessionId: s.id,
    });
  }

  sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return { generatedAt: Date.now(), adapters: statuses, sessions };
}
