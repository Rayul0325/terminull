/**
 * Tool registry store — `GET /api/tools` (DECLARED capabilities only; the
 * server deliberately reports no probe result here, so the UI must not imply
 * installed/not-installed). Shared by the account center and the
 * session-create stepper.
 */
import { create } from 'zustand';
import { ApiHttpError, api } from '../api/client';
import type { ToolListEntry } from '../api/types';

interface ToolsState {
  tools: ToolListEntry[];
  loaded: boolean;
  loading: boolean;
  errorCode: string | null;
  load(): Promise<void>;
}

export const useToolsStore = create<ToolsState>((set, get) => ({
  tools: [],
  loaded: false,
  loading: false,
  errorCode: null,

  load: async () => {
    if (get().loading) return;
    set({ loading: true });
    try {
      const res = await api.tools();
      set({ tools: res.tools, loaded: true, loading: false, errorCode: null });
    } catch (e) {
      const code = e instanceof ApiHttpError ? e.code : 'network';
      set({ loading: false, errorCode: code });
    }
  },
}));
