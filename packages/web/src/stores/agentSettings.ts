/**
 * Agent permission-settings store — GET/PUT round-trip against the contracted
 * /api/agent/permission-settings routes.
 *
 * Honesty contract: a toggle click is NEVER reflected as saved locally — the
 * row enters a `saving` state and the store replaces its rows with the SERVER
 * response (the new authoritative state, floors already applied). A failed PUT
 * leaves the previous class visible and surfaces the machine code verbatim.
 * The agent itself can never call these routes (server enforces user-only PUT;
 * this store is user-driven UI state only).
 */
import { create } from 'zustand';
import type { PermissionClass, PermissionSettingsDto } from '@terminull/shared';
import { ApiHttpError, api } from '../api/client';

/** Restrictiveness ordering (mirror of core): autonomous < confirm < forbidden. */
export const CLASS_RANK: Record<PermissionClass, number> = {
  autonomous: 0,
  confirm: 1,
  forbidden: 2,
};

/** True when `cls` may not be selected because the row's floor forbids it. */
export function belowFloor(cls: PermissionClass, floor: PermissionClass | undefined): boolean {
  return floor !== undefined && CLASS_RANK[cls] < CLASS_RANK[floor];
}

interface AgentSettingsState {
  settings: PermissionSettingsDto | null;
  loading: boolean;
  /** Machine code from the last failed GET (null = healthy). */
  errorCode: string | null;
  /** Machine code from the last failed PUT (cleared on next attempt). */
  saveErrorCode: string | null;
  /** Action ids with an in-flight PUT (row renders a saving state). */
  savingIds: string[];
  load(): Promise<void>;
  setClass(actionId: string, next: PermissionClass): Promise<void>;
}

export const useAgentSettingsStore = create<AgentSettingsState>((set, get) => ({
  settings: null,
  loading: false,
  errorCode: null,
  saveErrorCode: null,
  savingIds: [],

  load: async () => {
    if (get().loading) return;
    set({ loading: true });
    try {
      const settings = await api.agentPermissionSettings();
      set({ settings, loading: false, errorCode: null });
    } catch (e) {
      const code = e instanceof ApiHttpError ? e.code : 'network';
      set({ loading: false, errorCode: code });
    }
  },

  setClass: async (actionId, next) => {
    const { settings, savingIds } = get();
    const row = settings?.actions.find((a) => a.id === actionId);
    // Guard client-side what the server enforces anyway: no floor violations,
    // no duplicate in-flight writes for the same row.
    if (!row || row.class === next || savingIds.includes(actionId)) return;
    if (belowFloor(next, row.floor)) return;
    set({ savingIds: [...savingIds, actionId], saveErrorCode: null });
    try {
      const updated = await api.putAgentPermissionSettings({ [actionId]: next });
      // The 200 body is the full new server state — adopt it wholesale.
      set({
        settings: updated,
        savingIds: get().savingIds.filter((id) => id !== actionId),
      });
    } catch (e) {
      const code = e instanceof ApiHttpError ? e.code : 'network';
      // Previous class stays visible (nothing was optimistically flipped).
      set({
        saveErrorCode: code,
        savingIds: get().savingIds.filter((id) => id !== actionId),
      });
    }
  },
}));
