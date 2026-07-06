/**
 * Fleet snapshot store. The REST snapshot is authoritative; stream events only
 * schedule a throttled refetch (the server, not the client, owns fleet
 * normalization/dedup). `generatedAt` is surfaced so the UI can show data age
 * honestly instead of implying real-time.
 */
import { create } from 'zustand';
import type { Envelope } from '@terminull/shared';
import { api } from '../api/client';
import type { StreamStatus } from '../api/stream';
import type { FleetSession, FleetSnapshot } from '../api/types';

interface FleetState {
  snapshot: FleetSnapshot | null;
  loading: boolean;
  /** Machine error code from the last failed refresh (null = healthy). */
  errorCode: string | null;
  refresh(): Promise<void>;
  applyEvents(batch: Envelope[]): void;
  sessionById(id: string): FleetSession | undefined;
}

// machine.state included: a machine transition changes which sessions the
// server includes in the snapshot (stale machines contribute zero sessions).
const REFRESH_EVENT_TYPES = new Set([
  'session.start',
  'session.end',
  'host.up',
  'host.down',
  'machine.state',
]);
const THROTTLE_MS = 2000;

let throttleTimer: ReturnType<typeof setTimeout> | null = null;
let inflight: Promise<void> | null = null;

export const useFleetStore = create<FleetState>((set, get) => ({
  snapshot: null,
  loading: false,
  errorCode: null,

  refresh: async () => {
    if (inflight) return inflight;
    set({ loading: true });
    inflight = (async () => {
      try {
        const snapshot = await api.fleet();
        set({ snapshot, loading: false, errorCode: null });
      } catch (e) {
        const code =
          e instanceof Error && 'code' in e ? String((e as { code: unknown }).code) : 'network';
        set({ loading: false, errorCode: code });
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  },

  applyEvents: (batch) => {
    if (!batch.some((ev) => REFRESH_EVENT_TYPES.has(ev.type))) return;
    if (throttleTimer) return;
    throttleTimer = setTimeout(() => {
      throttleTimer = null;
      void get().refresh();
    }, THROTTLE_MS);
  },

  sessionById: (id) => get().snapshot?.sessions.find((s) => s.id === id),
}));

/** The machine a fleet session lives on ('local' when untagged — M8 additive field). */
export function sessionMachineId(session: FleetSession): string {
  return session.machine ?? 'local';
}

/** Group fleet sessions by machine id, mirroring {@link groupByProject}. */
export function groupByMachine(sessions: FleetSession[]): Map<string, FleetSession[]> {
  const groups = new Map<string, FleetSession[]>();
  for (const s of sessions) {
    const key = sessionMachineId(s);
    const list = groups.get(key) ?? [];
    list.push(s);
    groups.set(key, list);
  }
  return groups;
}

/** Group fleet sessions into projects by cwd ('' = cwd unknown, honest bucket). */
export function groupByProject(sessions: FleetSession[]): Map<string, FleetSession[]> {
  const groups = new Map<string, FleetSession[]>();
  for (const s of sessions) {
    const key = s.cwd ?? '';
    const list = groups.get(key) ?? [];
    list.push(s);
    groups.set(key, list);
  }
  return groups;
}

/** URL-safe project id from a cwd ('all' is reserved for the unfiltered view). */
export function projectIdOf(cwd: string | undefined): string {
  if (!cwd) return 'unknown';
  return encodeURIComponent(cwd);
}

/** Reverse of {@link projectIdOf} (null = the 'all' / 'unknown' pseudo-projects). */
export function cwdOfProjectId(projectId: string): string | null {
  if (projectId === 'all' || projectId === 'unknown') return null;
  try {
    return decodeURIComponent(projectId);
  } catch {
    return null;
  }
}

/** The one-line fleet health verdict (drives FleetHealthLine). */
export type FleetHealthLevel = 'ok' | 'attention' | 'offline';

/**
 * Derive the single glanceable fleet-health level from EXISTING web stores.
 * Terminull ported no governance loops (unlike the old control tower), so there
 * is no loop-gauge input here: a websocket that is not fully `online` is
 * `offline` — honest, since liveness cannot be verified while (re)connecting or
 * disconnected; any pending attention/approval item is `attention`; otherwise
 * `ok`. Pure so it unit-tests without mounting a store, and never green-by-
 * default (a dead socket always wins over an empty attention list).
 */
export function computeFleetHealth(input: {
  wsStatus: StreamStatus;
  attentionCount: number;
}): FleetHealthLevel {
  if (input.wsStatus !== 'online') return 'offline';
  if (input.attentionCount > 0) return 'attention';
  return 'ok';
}
