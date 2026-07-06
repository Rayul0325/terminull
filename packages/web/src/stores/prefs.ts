/**
 * User preferences — locale, theme, density, keybinding overrides. Persisted
 * to localStorage (device-local offline fallback). Keybinding overrides ALSO
 * roam through the server (M9 contract D6, `/api/prefs/keybindings`):
 *
 *  - on connect, the server document SEEDS the store (server wins);
 *  - every local edit updates the store AND full-replace PUTs the whole
 *    overrides map (combos are opaque server-side; no delta, no sha lock);
 *  - a failed GET/PUT leaves the localStorage copy in charge and surfaces an
 *    honest `keybindsSync:'error'` + machine code — never a silent fake-sync.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { KeybindingsDto } from '@terminull/shared';
import { ApiHttpError, api } from '../api/client';
import i18n from '../i18n';

export type ThemeMode = 'auto' | 'light' | 'dark';
export type ThemeFamily = 'observatory' | 'clear';
export type Density = 'comfortable' | 'compact';

/** Roaming state of the keybinding overrides document. */
export type KeybindsSyncState = 'local' | 'syncing' | 'synced' | 'error';

interface PrefsState {
  locale: string;
  theme: ThemeMode;
  /** Which palette family renders — 'observatory' (warm, default) or 'clear'. */
  themeFamily: ThemeFamily;
  density: Density;
  /** actionId → combo override (null = unbound). Missing key = default. */
  keybindOverrides: Record<string, string | null>;
  /** 'local' until the first server round trip; never fakes 'synced'. */
  keybindsSync: KeybindsSyncState;
  /** Machine code of the last failed sync (null = healthy). */
  keybindsSyncCode: string | null;
  setLocale(locale: string): void;
  setTheme(theme: ThemeMode): void;
  setThemeFamily(family: ThemeFamily): void;
  setDensity(density: Density): void;
  setKeybindOverride(actionId: string, combo: string | null): void;
  resetKeybinds(): void;
  /** Seed overrides from the server document (roaming; server wins). */
  loadServerKeybinds(): Promise<void>;
}

function applyTheme(theme: ThemeMode): void {
  if (typeof document === 'undefined') return;
  if (theme === 'auto') delete document.documentElement.dataset['theme'];
  else document.documentElement.dataset['theme'] = theme;
}

/**
 * Always stamp the family attribute (even 'observatory', the default) so the
 * family selector wins deterministically over the bare `:root` fallback — the
 * attribute is set, never deleted.
 */
function applyThemeFamily(family: ThemeFamily): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset['themeFamily'] = family;
}

/** Full-replace PUT of the whole overrides map (contract: never a delta). */
async function pushKeybinds(overrides: Record<string, string | null>): Promise<void> {
  const dto: KeybindingsDto = { version: 1, overrides };
  usePrefsStore.setState({ keybindsSync: 'syncing' });
  try {
    await api.putKeybindings(dto);
    usePrefsStore.setState({ keybindsSync: 'synced', keybindsSyncCode: null });
  } catch (e) {
    const code = e instanceof ApiHttpError ? e.code : 'network';
    usePrefsStore.setState({ keybindsSync: 'error', keybindsSyncCode: code });
  }
}

export const usePrefsStore = create<PrefsState>()(
  persist(
    (set, get) => ({
      locale: 'ko',
      theme: 'auto' as ThemeMode,
      themeFamily: 'observatory' as ThemeFamily,
      density: 'comfortable' as Density,
      keybindOverrides: {},
      keybindsSync: 'local' as KeybindsSyncState,
      keybindsSyncCode: null,

      setLocale: (locale) => {
        set({ locale });
        void i18n.changeLanguage(locale);
      },
      setTheme: (theme) => {
        set({ theme });
        applyTheme(theme);
      },
      setThemeFamily: (family) => {
        set({ themeFamily: family });
        applyThemeFamily(family);
      },
      setDensity: (density) => set({ density }),
      setKeybindOverride: (actionId, combo) => {
        const keybindOverrides = { ...get().keybindOverrides, [actionId]: combo };
        set({ keybindOverrides });
        void pushKeybinds(keybindOverrides);
      },
      resetKeybinds: () => {
        set({ keybindOverrides: {} });
        void pushKeybinds({});
      },
      loadServerKeybinds: async () => {
        try {
          const dto = await api.keybindings();
          // Server document wins on connect (D6 merge order); local edits made
          // while offline are superseded — localStorage stays only a fallback.
          set({
            keybindOverrides: dto.overrides,
            keybindsSync: 'synced',
            keybindsSyncCode: null,
          });
        } catch (e) {
          const code = e instanceof ApiHttpError ? e.code : 'network';
          set({ keybindsSync: 'error', keybindsSyncCode: code });
        }
      },
    }),
    {
      name: 'terminull.prefs',
      // Sync status is a live wire-state, not a preference — never persisted
      // (a stale 'synced' from a previous run would be a lie).
      partialize: (state) => ({
        locale: state.locale,
        theme: state.theme,
        themeFamily: state.themeFamily,
        density: state.density,
        keybindOverrides: state.keybindOverrides,
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        applyTheme(state.theme);
        applyThemeFamily(state.themeFamily);
        if (state.locale !== i18n.language) void i18n.changeLanguage(state.locale);
      },
    },
  ),
);
