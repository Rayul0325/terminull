/**
 * Per-session GUI statusbar store (M9 W3). Data source = the claude statusline
 * stdin payload, folded by the adapter into a SessionStatusDto and ingested as
 * the postable `session.status` event; the REST seed is
 * `GET /api/sessions/:sid/status`.
 *
 * Honesty rules (contract D5): entries are keyed by the TOOL-NATIVE session id
 * (`toolId:toolSessionId` — the same id space the fleet reports), the LATEST
 * payload wins, invalid payloads are DROPPED (never coerced), and absent data
 * is `null`/no-entry — the UI renders placeholders, never fabricated zeros.
 * `session.status` is forgeable by design: display only, nothing gates on it.
 */
import { create } from 'zustand';
import type { Envelope, SessionStatusDto } from '@terminull/shared';
import { api } from '../api/client';

/** Store key for one session's status. */
export function statusKeyOf(toolId: string, toolSessionId: string): string {
  return `${toolId}:${toolSessionId}`;
}

/**
 * Client-side shape guard for a `session.status` payload. The server validates
 * before folding, but the stream payload is `unknown` on this side — mirror
 * the schema structurally (machines-store pattern) instead of trusting casts.
 */
export function asSessionStatus(p: unknown): SessionStatusDto | null {
  if (p === null || typeof p !== 'object' || Array.isArray(p)) return null;
  const o = p as Record<string, unknown>;
  if (typeof o['toolId'] !== 'string' || o['toolId'].length === 0) return null;
  if (typeof o['toolSessionId'] !== 'string' || o['toolSessionId'].length === 0) return null;
  let model: SessionStatusDto['model'] = null;
  if (o['model'] !== null && o['model'] !== undefined) {
    const m = o['model'];
    if (m === null || typeof m !== 'object' || Array.isArray(m)) return null;
    const mo = m as Record<string, unknown>;
    if (typeof mo['id'] !== 'string' || typeof mo['label'] !== 'string') return null;
    model = { id: mo['id'], label: mo['label'] };
  }
  let contextTokens: SessionStatusDto['contextTokens'] = null;
  if (o['contextTokens'] !== null && o['contextTokens'] !== undefined) {
    const c = o['contextTokens'];
    if (c === null || typeof c !== 'object' || Array.isArray(c)) return null;
    const co = c as Record<string, unknown>;
    if (
      typeof co['used'] !== 'number' ||
      typeof co['max'] !== 'number' ||
      typeof co['usedPercent'] !== 'number'
    ) {
      return null;
    }
    contextTokens = { used: co['used'], max: co['max'], usedPercent: co['usedPercent'] };
  }
  const costUsd = o['costUsd'];
  if (costUsd !== null && costUsd !== undefined && typeof costUsd !== 'number') return null;
  const asOf = o['asOf'];
  if (asOf !== null && asOf !== undefined && typeof asOf !== 'number') return null;
  return {
    toolId: o['toolId'],
    toolSessionId: o['toolSessionId'],
    model,
    contextTokens,
    costUsd: typeof costUsd === 'number' ? costUsd : null,
    asOf: typeof asOf === 'number' ? asOf : null,
  };
}

interface SessionStatusState {
  /** Latest DTO per `toolId:toolSessionId`; absence = honest "no data". */
  statuses: Record<string, SessionStatusDto>;
  /** Keys a REST seed was already attempted for (avoid refetch loops). */
  seeded: Record<string, true>;
  applyEvents(batch: Envelope[]): void;
  /** One-shot REST seed for a session (idempotent per key). */
  seed(toolId: string, toolSessionId: string): Promise<void>;
}

export const useSessionStatusStore = create<SessionStatusState>((set, get) => ({
  statuses: {},
  seeded: {},

  applyEvents: (batch) => {
    let statuses = get().statuses;
    let changed = false;
    for (const ev of batch) {
      if (ev.type !== 'session.status') continue;
      const dto = asSessionStatus(ev.payload);
      if (dto === null) continue; // invalid payload dropped, never coerced
      statuses = { ...statuses, [statusKeyOf(dto.toolId, dto.toolSessionId)]: dto };
      changed = true;
    }
    if (changed) set({ statuses });
  },

  seed: async (toolId, toolSessionId) => {
    const key = statusKeyOf(toolId, toolSessionId);
    if (get().seeded[key] === true) return;
    set({ seeded: { ...get().seeded, [key]: true } });
    try {
      const res = await api.sessionStatus(toolSessionId);
      if (res.status === null) return; // honest no-data — nothing to render
      const dto = asSessionStatus(res.status);
      if (dto === null) return;
      // A WS event may have landed while the seed was in flight — the stream
      // fold is newer, keep it.
      if (get().statuses[key] !== undefined) return;
      set({ statuses: { ...get().statuses, [key]: dto } });
    } catch {
      /* seed failure = no data; the stream can still populate it later */
    }
  },
}));
