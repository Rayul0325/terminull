/**
 * Account-profile registry store (M9 contract, `/api/profiles`). A profile is
 * ONLY a pointer `{id, toolId, label, configHome}` — the client never sees or
 * moves credentials, and SWITCHING affects NEW spawns only (the server injects
 * the config-home env at spawn time). The switch response's
 * `liveSessionCount` is surfaced verbatim so the UI can tell the user exactly
 * how many running sessions keep their old account — the server never
 * restarts anything on the user's behalf, and neither does this store.
 */
import { create } from 'zustand';
import type { ProfileSwitchResponse, ToolProfileDto } from '@terminull/shared';
import { ApiHttpError, api } from '../api/client';

export const DEFAULT_PROFILE = 'default';

interface ProfilesState {
  profiles: ToolProfileDto[];
  /** toolId → active profileId; a missing key = the implicit default. */
  active: Record<string, string>;
  loaded: boolean;
  loading: boolean;
  errorCode: string | null;
  /** Result of the last successful switch (honest done-note source). */
  lastSwitch: ProfileSwitchResponse | null;
  load(): Promise<void>;
  create(profile: ToolProfileDto): Promise<string | null>;
  remove(toolId: string, profileId: string): Promise<string | null>;
  /** Returns the machine error code, or null on success. */
  switchTo(toolId: string, profileId: string): Promise<string | null>;
}

export const useProfilesStore = create<ProfilesState>((set, get) => ({
  profiles: [],
  active: {},
  loaded: false,
  loading: false,
  errorCode: null,
  lastSwitch: null,

  load: async () => {
    if (get().loading) return;
    set({ loading: true });
    try {
      const res = await api.profiles();
      set({
        profiles: res.profiles,
        active: res.active,
        loaded: true,
        loading: false,
        errorCode: null,
      });
    } catch (e) {
      const code = e instanceof ApiHttpError ? e.code : 'network';
      set({ loading: false, errorCode: code });
    }
  },

  create: async (profile) => {
    try {
      const res = await api.createProfile(profile);
      set({ profiles: [...get().profiles, res.profile] });
      return null;
    } catch (e) {
      return e instanceof ApiHttpError ? e.code : 'network';
    }
  },

  remove: async (toolId, profileId) => {
    try {
      await api.deleteProfile(toolId, profileId);
      set({
        profiles: get().profiles.filter((p) => !(p.toolId === toolId && p.id === profileId)),
        // Deleting the active profile falls back to default server-side.
        active: Object.fromEntries(
          Object.entries(get().active).filter(([t, p]) => !(t === toolId && p === profileId)),
        ),
      });
      return null;
    } catch (e) {
      return e instanceof ApiHttpError ? e.code : 'network';
    }
  },

  switchTo: async (toolId, profileId) => {
    try {
      const res = await api.switchProfile(toolId, profileId);
      const active = { ...get().active };
      if (res.profileId === DEFAULT_PROFILE) delete active[toolId];
      else active[toolId] = res.profileId;
      set({ active, lastSwitch: res });
      return null;
    } catch (e) {
      return e instanceof ApiHttpError ? e.code : 'network';
    }
  },
}));

/** Registry profiles of one tool (the implicit default is NOT in the list). */
export function profilesForTool(profiles: ToolProfileDto[], toolId: string): ToolProfileDto[] {
  return profiles.filter((p) => p.toolId === toolId);
}

/** Active profile id of a tool (missing entry = the implicit default). */
export function activeProfileOf(active: Record<string, string>, toolId: string): string {
  return active[toolId] ?? DEFAULT_PROFILE;
}
