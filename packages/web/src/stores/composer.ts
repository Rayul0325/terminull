/**
 * Composer store — per-session drafts + optimistic directive tracking.
 *
 * Honesty contract (plan §상태): an optimistic entry is born 'sending' (⏳)
 * and turns 'delivered' (✓) ONLY on the server's confirmation; a 202 becomes
 * 'queued' (delivery-at-next-turn) and a gate park becomes
 * 'pending_confirmation'. Failures keep the text so the user can retry —
 * nothing green before the server says so.
 */
import { create } from 'zustand';
import { ApiHttpError, api } from '../api/client';

export type DirectiveSendState =
  'sending' | 'delivered' | 'queued' | 'pending_confirmation' | 'failed';

export interface PendingDirective {
  localId: string;
  sessionId: string;
  text: string;
  state: DirectiveSendState;
  directiveId?: string;
  confirmationId?: string;
  errorCode?: string;
  ts: number;
}

interface ComposerState {
  drafts: Record<string, string>;
  pending: PendingDirective[];
  setDraft(sessionId: string, text: string): void;
  send(sessionId: string): Promise<void>;
  dismiss(localId: string): void;
}

const MAX_PENDING = 100;
let nextLocal = 1;

export const useComposerStore = create<ComposerState>((set, get) => ({
  drafts: {},
  pending: [],

  setDraft: (sessionId, text) => set({ drafts: { ...get().drafts, [sessionId]: text } }),

  send: async (sessionId) => {
    const text = (get().drafts[sessionId] ?? '').trim();
    if (text.length === 0) return;
    const localId = `d${nextLocal++}`;
    const entry: PendingDirective = {
      localId,
      sessionId,
      text,
      state: 'sending',
      ts: Date.now(),
    };
    set({
      drafts: { ...get().drafts, [sessionId]: '' },
      pending: [...get().pending, entry].slice(-MAX_PENDING),
    });
    const update = (patch: Partial<PendingDirective>): void => {
      set({
        pending: get().pending.map((p) => (p.localId === localId ? { ...p, ...patch } : p)),
      });
    };
    try {
      const res = await api.sendDirective(sessionId, text);
      if (res.delivered) {
        update({
          state: 'delivered',
          ...(res.directiveId !== undefined ? { directiveId: res.directiveId } : {}),
        });
      } else if (res.confirmationId) {
        update({ state: 'pending_confirmation', confirmationId: res.confirmationId });
      } else if (res.queued) {
        update({
          state: 'queued',
          ...(res.directiveId !== undefined ? { directiveId: res.directiveId } : {}),
        });
      } else {
        // A 2xx without any recognized field is a contract drift — surface it.
        update({ state: 'failed', errorCode: 'unexpected_response' });
      }
    } catch (e) {
      const code = e instanceof ApiHttpError ? e.code : 'network';
      // Restore the draft so a failed send is one keystroke from retry.
      set({ drafts: { ...get().drafts, [sessionId]: text } });
      update({ state: 'failed', errorCode: code });
    }
  },

  dismiss: (localId) => set({ pending: get().pending.filter((p) => p.localId !== localId) }),
}));
