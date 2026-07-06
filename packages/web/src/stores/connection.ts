/**
 * Connection + attention store. Stream events arrive from OUTSIDE React via
 * the ingest module (src/stores/ingest.ts); components read, and may resolve
 * confirmation/ask items inline through the actions below.
 *
 * Attention mirrors the server's honest projections: pending CONFIRMATIONS are
 * seeded from `GET /api/confirmations` on connect (M9 W7 — a reload no longer
 * loses them) and kept live from `confirmation.*` events; asks/permissions
 * remain stream-granularity (their pre-connect backlog has no REST projection
 * yet) — the UI labels the section accordingly rather than pretending
 * completeness. Inline resolution is optimistic-PENDING only: an item turns
 * final on the server's 200 (or the matching stream event), never before.
 */
import { create } from 'zustand';
import type { Envelope } from '@terminull/shared';
import { ApiHttpError, api } from '../api/client';
import type { ConfirmationsResponse } from '../api/types';
import type { StreamStatus } from '../api/stream';

/** Delivery outcome of an inline ask answer (mirrors the composer states). */
export type AskAnswerState = 'sending' | 'delivered' | 'queued' | 'pendingConfirmation';

export interface AttentionItem {
  key: string;
  kind: 'ask' | 'permission' | 'confirmation';
  sessionId?: string;
  ts: number;
  /** Free-text summary when the event payload carried one (already masked server-side). */
  summary?: string;
  /** Ask options offered by the session, when the ask payload carried them. */
  options?: string[];
  /** Confirmation id / ask id for inline resolution. */
  refId?: string;
  /** True while an inline resolve/answer round trip is in flight. */
  resolving?: boolean;
  /** Machine code of the last failed inline action (item stays actionable). */
  errorCode?: string;
  /** Set once an inline ask answer was accepted by the server (item stays
   * until the authoritative ask.answered/ask.expired event clears it). */
  answerState?: AskAnswerState;
}

interface ConnectionState {
  wsStatus: StreamStatus;
  seq: number;
  hostConnected: boolean | null; // null = not yet known (no health/hello seen)
  attention: AttentionItem[];
  setWsStatus(status: StreamStatus): void;
  setHostConnected(connected: boolean): void;
  applyEvents(batch: Envelope[]): void;
  /** Merge the REST confirmations snapshot (authoritative for pending). */
  seedConfirmations(pending: ConfirmationsResponse['pending']): void;
  /** Inline approve/reject of a pending confirmation. */
  resolveConfirmation(id: string, decision: 'approve' | 'reject'): Promise<void>;
  /** Inline ask answer — delivered as a directive to the asking session. */
  answerAsk(key: string, text: string): Promise<void>;
}

const MAX_ATTENTION = 50;

function payloadString(ev: Envelope, key: string): string | undefined {
  const p = ev.payload;
  if (p && typeof p === 'object' && !Array.isArray(p)) {
    const v = (p as Record<string, unknown>)[key];
    if (typeof v === 'string') return v;
  }
  return undefined;
}

/** String-array payload field (ask `options`); anything else = undefined. */
function payloadStringArray(ev: Envelope, key: string): string[] | undefined {
  const p = ev.payload;
  if (p && typeof p === 'object' && !Array.isArray(p)) {
    const v = (p as Record<string, unknown>)[key];
    if (Array.isArray(v) && v.every((entry) => typeof entry === 'string') && v.length > 0) {
      return v as string[];
    }
  }
  return undefined;
}

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  wsStatus: 'offline',
  seq: 0,
  hostConnected: null,
  attention: [],

  setWsStatus: (wsStatus) => set({ wsStatus }),
  setHostConnected: (hostConnected) => set({ hostConnected }),

  applyEvents: (batch) => {
    let { attention, hostConnected } = get();
    let seq = get().seq;
    let attentionChanged = false;
    const remove = (predicate: (a: AttentionItem) => boolean): void => {
      const next = attention.filter((a) => !predicate(a));
      if (next.length !== attention.length) {
        attention = next;
        attentionChanged = true;
      }
    };
    for (const ev of batch) {
      seq = Math.max(seq, ev.seq);
      switch (ev.type) {
        case 'host.up':
          hostConnected = true;
          break;
        case 'host.down':
          hostConnected = false;
          break;
        case 'session.ask': {
          const askId = payloadString(ev, 'askId') ?? `seq${ev.seq}`;
          const options = payloadStringArray(ev, 'options');
          attention = [
            ...attention,
            {
              key: `ask:${askId}`,
              kind: 'ask',
              refId: askId,
              ...(ev.sessionId !== undefined ? { sessionId: ev.sessionId } : {}),
              ts: ev.ts,
              ...(payloadString(ev, 'summary') !== undefined
                ? { summary: payloadString(ev, 'summary') }
                : {}),
              ...(options !== undefined ? { options } : {}),
            },
          ];
          attentionChanged = true;
          break;
        }
        case 'ask.answered':
        case 'ask.expired': {
          const askId = payloadString(ev, 'askId');
          if (askId) remove((a) => a.key === `ask:${askId}`);
          break;
        }
        case 'session.needs_permission':
          if (ev.sessionId) {
            remove((a) => a.kind === 'permission' && a.sessionId === ev.sessionId);
            attention = [
              ...attention,
              {
                key: `perm:${ev.sessionId}:${ev.seq}`,
                kind: 'permission',
                sessionId: ev.sessionId,
                ts: ev.ts,
              },
            ];
            attentionChanged = true;
          }
          break;
        case 'confirmation.pending': {
          const id = payloadString(ev, 'confirmationId') ?? `seq${ev.seq}`;
          // The REST seed may already carry this confirmation — never duplicate.
          if (attention.some((a) => a.key === `confirm:${id}`)) break;
          attention = [
            ...attention,
            {
              key: `confirm:${id}`,
              kind: 'confirmation',
              refId: id,
              ...(ev.sessionId !== undefined ? { sessionId: ev.sessionId } : {}),
              ts: ev.ts,
              ...(payloadString(ev, 'action') !== undefined
                ? { summary: payloadString(ev, 'action') }
                : {}),
            },
          ];
          attentionChanged = true;
          break;
        }
        case 'confirmation.approved':
        case 'confirmation.rejected': {
          const id = payloadString(ev, 'confirmationId');
          if (id) remove((a) => a.key === `confirm:${id}`);
          break;
        }
        // Any further session activity clears its pending-permission flag
        // (same projection rule as the core store).
        case 'session.report':
        case 'session.activity':
        case 'session.idle':
        case 'session.start':
          if (ev.sessionId) remove((a) => a.kind === 'permission' && a.sessionId === ev.sessionId);
          break;
        case 'session.end':
          if (ev.sessionId) remove((a) => a.sessionId === ev.sessionId);
          break;
        default:
          break;
      }
    }
    if (attention.length > MAX_ATTENTION) {
      attention = attention.slice(attention.length - MAX_ATTENTION);
      attentionChanged = true;
    }
    set({
      seq,
      hostConnected,
      ...(attentionChanged ? { attention } : {}),
    });
  },

  seedConfirmations: (pending) => {
    const existing = new Set(get().attention.map((a) => a.key));
    const seeded: AttentionItem[] = [];
    for (const p of pending) {
      const key = `confirm:${p.id}`;
      if (existing.has(key)) continue;
      seeded.push({
        key,
        kind: 'confirmation',
        refId: p.id,
        ...(p.sessionId !== undefined ? { sessionId: p.sessionId } : {}),
        ts: p.createdAt,
        summary: p.action,
      });
    }
    if (seeded.length === 0) return;
    // Seed entries are OLDER than anything the live stream added — prepend.
    set({ attention: [...seeded, ...get().attention] });
  },

  resolveConfirmation: async (id, decision) => {
    const key = `confirm:${id}`;
    const patch = (p: Partial<AttentionItem>): void => {
      set({ attention: get().attention.map((a) => (a.key === key ? { ...a, ...p } : a)) });
    };
    const item = get().attention.find((a) => a.key === key);
    if (!item || item.resolving === true) return;
    patch({ resolving: true, errorCode: undefined });
    try {
      if (decision === 'approve') await api.approveConfirmation(id);
      else await api.rejectConfirmation(id);
      // Resolved on the server's 200 — the confirmation.* event would remove
      // it too, but the REST answer is already authoritative.
      set({ attention: get().attention.filter((a) => a.key !== key) });
    } catch (e) {
      if (e instanceof ApiHttpError && e.status === 404) {
        // In-memory queue lost it (restart / already resolved) — honest gone.
        set({ attention: get().attention.filter((a) => a.key !== key) });
        return;
      }
      const code = e instanceof ApiHttpError ? e.code : 'network';
      patch({ resolving: false, errorCode: code });
    }
  },

  answerAsk: async (key, text) => {
    const item = get().attention.find((a) => a.key === key);
    if (!item || item.kind !== 'ask' || item.sessionId === undefined) return;
    if (item.resolving === true) return;
    const patch = (p: Partial<AttentionItem>): void => {
      set({ attention: get().attention.map((a) => (a.key === key ? { ...a, ...p } : a)) });
    };
    patch({ resolving: true, errorCode: undefined, answerState: 'sending' });
    try {
      const res = await api.sendDirective(item.sessionId, text);
      // Honest delivery state — the item clears only on the authoritative
      // ask.answered/ask.expired event, never on our own optimism.
      const answerState: AskAnswerState =
        res.delivered === true
          ? 'delivered'
          : res.confirmationId !== undefined
            ? 'pendingConfirmation'
            : 'queued';
      patch({ resolving: false, answerState });
    } catch (e) {
      const code = e instanceof ApiHttpError ? e.code : 'network';
      patch({ resolving: false, errorCode: code, answerState: undefined });
    }
  },
}));
