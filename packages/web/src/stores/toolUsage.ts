/**
 * Tool usage/account store — GET /api/tools/:toolId/usage (+ /account) with
 * the M7 capability-honesty error contract: 422 `adapter_unsupported` is a
 * NORMAL state (the tool has no usage surface), rendered as such and never as
 * a broken gauge; `available:false` gauges keep their adapter-supplied reason.
 * Freshness metadata (`stale-turn-gated`, `asOf`) is stored verbatim so the
 * UI can label data age honestly.
 */
import { create } from 'zustand';
import type { UsageGaugeDto } from '@terminull/shared';
import { ApiHttpError, api } from '../api/client';
import type { ToolAccountResponse } from '../api/types';

export interface ToolUsageEntry {
  toolId: string;
  /** null until fetched; stays null on unsupported/error. */
  gauge: UsageGaugeDto | null;
  /** null = not known yet; false = 422 adapter_unsupported / 404 unknown tool. */
  supported: boolean | null;
  loading: boolean;
  /** Machine code from the last failed fetch (null = healthy). */
  errorCode: string | null;
  account: ToolAccountResponse | null;
  fetchedAt?: number;
}

interface ToolUsageState {
  entries: Record<string, ToolUsageEntry>;
  load(toolId: string): Promise<void>;
}

function blank(toolId: string): ToolUsageEntry {
  return { toolId, gauge: null, supported: null, loading: false, errorCode: null, account: null };
}

export const useToolUsageStore = create<ToolUsageState>((set, get) => ({
  entries: {},

  load: async (toolId) => {
    const current = get().entries[toolId] ?? blank(toolId);
    if (current.loading) return;
    const patch = (p: Partial<ToolUsageEntry>): void => {
      const prev = get().entries[toolId] ?? blank(toolId);
      set({ entries: { ...get().entries, [toolId]: { ...prev, ...p } } });
    };
    patch({ loading: true });
    try {
      const gauge = await api.toolUsage(toolId);
      patch({
        gauge,
        supported: true,
        loading: false,
        errorCode: null,
        fetchedAt: Date.now(),
      });
    } catch (e) {
      if (e instanceof ApiHttpError && (e.status === 422 || e.status === 404)) {
        // Contract: known tool without the surface → 422 adapter_unsupported;
        // unknown tool → 404. Both are honest "no gauge here" states.
        patch({ gauge: null, supported: false, loading: false, errorCode: e.code });
        return;
      }
      const code = e instanceof ApiHttpError ? e.code : 'network';
      patch({ loading: false, errorCode: code });
      return;
    }
    // Account identity is best-effort decoration — its failure never breaks
    // the gauge (the whoami passthrough may be unsupported independently).
    try {
      const account = await api.toolAccount(toolId);
      patch({ account });
    } catch {
      patch({ account: null });
    }
  },
}));
