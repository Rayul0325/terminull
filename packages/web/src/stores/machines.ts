/**
 * Machine registry store (M8). Seeded from the fleet snapshot's `machines[]`
 * (REST is authoritative, same philosophy as the fleet store) and live-updated
 * from `machine.state` WS envelopes via the ingest module.
 *
 * Honesty rules mirror the shared FSM contract: a machine that stops
 * responding is `stale` with `lastSeenAt` (last VERIFIED contact) — never
 * silently dropped, never shown as connected. A machine never yet reached
 * stays `connecting` (there is no lastSeen to report). The UI must render a
 * stale machine's sessions as a stale snapshot, never as live.
 */
import { create } from 'zustand';
import type {
  Envelope,
  MachineConnectionState,
  MachineStateDto,
  MachineStatePayload,
} from '@terminull/shared';
import { api } from '../api/client';

/**
 * The implicit machine every install has (mirrors shared LOCAL_MACHINE_ID —
 * kept as a local literal so the browser bundle never pulls the zod-bearing
 * shared runtime; the type annotation below keeps it contract-checked).
 */
export const LOCAL_MACHINE = 'local';

/** All FSM states (runtime mirror of the shared union, type-checked). */
const STATES: readonly MachineConnectionState[] = ['connecting', 'connected', 'stale', 'disabled'];

/** Transition codes that describe a failure and belong on `lastError`. */
const FAILURE_CODES = new Set(['dial_failed', 'relay_exit', 'heartbeat_timeout', 'link_closed']);

function isState(v: unknown): v is MachineConnectionState {
  return typeof v === 'string' && (STATES as readonly string[]).includes(v);
}

/** Validate an unknown event payload into a MachineStatePayload (null = not ours). */
export function asMachineStatePayload(p: unknown): MachineStatePayload | null {
  if (p === null || typeof p !== 'object' || Array.isArray(p)) return null;
  const o = p as Record<string, unknown>;
  if (typeof o['machineId'] !== 'string' || o['machineId'].length === 0) return null;
  if (!isState(o['state']) || !isState(o['previous'])) return null;
  if (o['lastSeenAt'] !== null && typeof o['lastSeenAt'] !== 'number') return null;
  if (typeof o['code'] !== 'string' || o['code'].length === 0) return null;
  return {
    machineId: o['machineId'],
    previous: o['previous'],
    state: o['state'],
    lastSeenAt: o['lastSeenAt'],
    code: o['code'],
  } as MachineStatePayload;
}

/**
 * Fold one `machine.state` transition into a machine entry. Pure — unit-tested
 * directly. The payload's `lastSeenAt` is authoritative (the server computed
 * it from the last verified contact); a `connected` transition clears the
 * failure streak (`lastError`/`attempts`) because the dial verifiably worked.
 */
export function reduceMachineState(
  current: MachineStateDto | undefined,
  p: MachineStatePayload,
): MachineStateDto {
  const base: MachineStateDto = current ?? {
    id: p.machineId,
    label: p.machineId,
    state: p.previous,
    lastSeenAt: null,
  };
  const next: MachineStateDto = {
    ...base,
    state: p.state,
    lastSeenAt: p.lastSeenAt,
    ...(FAILURE_CODES.has(p.code) ? { lastError: p.code } : {}),
  };
  if (p.state === 'connected') {
    delete next.lastError;
    delete next.attempts;
  }
  return next;
}

function toMap(list: MachineStateDto[]): Record<string, MachineStateDto> {
  const map: Record<string, MachineStateDto> = {};
  for (const m of list) map[m.id] = m;
  return map;
}

interface MachinesState {
  machines: Record<string, MachineStateDto>;
  loading: boolean;
  /** Machine error code from the last failed refresh (null = healthy). */
  errorCode: string | null;
  /** REST refresh from `GET /api/machines` (settings section, gap recovery). */
  refresh(): Promise<void>;
  /** Replace entries from a fleet snapshot; `undefined` (pre-M8 server) keeps state. */
  seedFromFleet(machines: MachineStateDto[] | undefined): void;
  applyEvents(batch: Envelope[]): void;
}

export const useMachinesStore = create<MachinesState>((set, get) => ({
  machines: {},
  loading: false,
  errorCode: null,

  refresh: async () => {
    set({ loading: true });
    try {
      const res = await api.machines();
      set({ machines: toMap(res.machines), loading: false, errorCode: null });
    } catch (e) {
      const code =
        e instanceof Error && 'code' in e ? String((e as { code: unknown }).code) : 'network';
      set({ loading: false, errorCode: code });
    }
  },

  seedFromFleet: (list) => {
    if (list === undefined) return; // server predates the machine registry — honest absence
    set({ machines: toMap(list), errorCode: null });
  },

  applyEvents: (batch) => {
    let machines = get().machines;
    let changed = false;
    for (const ev of batch) {
      if (ev.type !== 'machine.state') continue;
      const p = asMachineStatePayload(ev.payload);
      if (p === null) continue;
      if (!changed) machines = { ...machines };
      machines[p.machineId] = reduceMachineState(machines[p.machineId], p);
      changed = true;
    }
    if (changed) set({ machines });
  },
}));

/** Machines as a stable render list: 'local' first, then id order. */
export function machinesList(machines: Record<string, MachineStateDto>): MachineStateDto[] {
  return Object.values(machines).sort((a, b) => {
    if (a.id === LOCAL_MACHINE) return -1;
    if (b.id === LOCAL_MACHINE) return 1;
    return a.id.localeCompare(b.id);
  });
}

/**
 * Split `now - lastSeenAt` into the largest sensible unit for the honest
 * "마지막 확인 n분 전" chip (i18n key family `machines.lastSeen.*`).
 */
export function lastSeenParts(
  lastSeenAt: number,
  now: number,
): { unit: 'seconds' | 'minutes' | 'hours' | 'days'; count: number } {
  const seconds = Math.max(0, Math.floor((now - lastSeenAt) / 1000));
  if (seconds < 60) return { unit: 'seconds', count: seconds };
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return { unit: 'minutes', count: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { unit: 'hours', count: hours };
  return { unit: 'days', count: Math.floor(hours / 24) };
}
