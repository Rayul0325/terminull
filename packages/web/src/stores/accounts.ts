/**
 * Per-tool account identity store — `GET /api/tools/:toolId/account`
 * passthrough of the adapter's honest AccountResults. A tool whose adapter
 * cannot (or will not) read identity yields `available:false` / a 422 — both
 * are NORMAL "확인 불가" states, rendered as such and never as a blank-green
 * card. Nothing here ever touches credential bodies; adapters only report
 * what they are willing to read (codex: presence only).
 */
import { create } from 'zustand';
import { ApiHttpError, api } from '../api/client';
import type { ToolAccountResponse } from '../api/types';

export interface ToolAccountEntry {
  toolId: string;
  account: ToolAccountResponse | null;
  /** null = not fetched yet; false = 422/404 (no account surface). */
  supported: boolean | null;
  loading: boolean;
  errorCode: string | null;
}

interface AccountsState {
  entries: Record<string, ToolAccountEntry>;
  load(toolId: string): Promise<void>;
}

function blank(toolId: string): ToolAccountEntry {
  return { toolId, account: null, supported: null, loading: false, errorCode: null };
}

export const useAccountsStore = create<AccountsState>((set, get) => ({
  entries: {},

  load: async (toolId) => {
    const current = get().entries[toolId] ?? blank(toolId);
    if (current.loading) return;
    const patch = (p: Partial<ToolAccountEntry>): void => {
      const prev = get().entries[toolId] ?? blank(toolId);
      set({ entries: { ...get().entries, [toolId]: { ...prev, ...p } } });
    };
    patch({ loading: true });
    try {
      const account = await api.toolAccount(toolId);
      patch({ account, supported: true, loading: false, errorCode: null });
    } catch (e) {
      if (e instanceof ApiHttpError && (e.status === 422 || e.status === 404)) {
        // Honest "no account surface" — not an error banner.
        patch({ account: null, supported: false, loading: false, errorCode: e.code });
        return;
      }
      const code = e instanceof ApiHttpError ? e.code : 'network';
      patch({ loading: false, errorCode: code });
    }
  },
}));
