/**
 * Connection + attention store. Fed exclusively from OUTSIDE React by the
 * ingest module (src/stores/ingest.ts) — components only read.
 *
 * Attention mirrors the server's honest projections at stream granularity:
 * entries appear on `session.ask` / `session.needs_permission` /
 * `confirmation.pending` and clear on their counterparts. History from before
 * this client connected is NOT reconstructed (the pre-connect backlog is a
 * server-projection REST endpoint, tracked as a follow-up) — the UI labels
 * the section accordingly rather than pretending completeness.
 */
import { create } from 'zustand';
import type { Envelope } from '@terminull/shared';
import type { StreamStatus } from '../api/stream';

export interface AttentionItem {
  key: string;
  kind: 'ask' | 'permission' | 'confirmation';
  sessionId?: string;
  ts: number;
  /** Free-text summary when the event payload carried one (already masked server-side). */
  summary?: string;
}

interface ConnectionState {
  wsStatus: StreamStatus;
  seq: number;
  hostConnected: boolean | null; // null = not yet known (no health/hello seen)
  attention: AttentionItem[];
  setWsStatus(status: StreamStatus): void;
  setHostConnected(connected: boolean): void;
  applyEvents(batch: Envelope[]): void;
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
          attention = [
            ...attention,
            {
              key: `ask:${askId}`,
              kind: 'ask',
              ...(ev.sessionId !== undefined ? { sessionId: ev.sessionId } : {}),
              ts: ev.ts,
              ...(payloadString(ev, 'summary') !== undefined
                ? { summary: payloadString(ev, 'summary') }
                : {}),
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
          attention = [
            ...attention,
            {
              key: `confirm:${id}`,
              kind: 'confirmation',
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
}));
