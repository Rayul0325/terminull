/**
 * User preferences — locale, theme, density, keybinding overrides. Persisted
 * to localStorage (device-local); cross-device sync rides the same server
 * channel as layout templates once that endpoint exists (see layout.ts stub).
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import i18n from '../i18n';

export type ThemeMode = 'auto' | 'light' | 'dark';
export type Density = 'comfortable' | 'compact';

interface PrefsState {
  locale: string;
  theme: ThemeMode;
  density: Density;
  /** actionId → combo override (null = unbound). Missing key = default. */
  keybindOverrides: Record<string, string | null>;
  setLocale(locale: string): void;
  setTheme(theme: ThemeMode): void;
  setDensity(density: Density): void;
  setKeybindOverride(actionId: string, combo: string | null): void;
  resetKeybinds(): void;
}

function applyTheme(theme: ThemeMode): void {
  if (typeof document === 'undefined') return;
  if (theme === 'auto') delete document.documentElement.dataset['theme'];
  else document.documentElement.dataset['theme'] = theme;
}

export const usePrefsStore = create<PrefsState>()(
  persist(
    (set, get) => ({
      locale: 'ko',
      theme: 'auto' as ThemeMode,
      density: 'comfortable' as Density,
      keybindOverrides: {},

      setLocale: (locale) => {
        set({ locale });
        void i18n.changeLanguage(locale);
      },
      setTheme: (theme) => {
        set({ theme });
        applyTheme(theme);
      },
      setDensity: (density) => set({ density }),
      setKeybindOverride: (actionId, combo) =>
        set({ keybindOverrides: { ...get().keybindOverrides, [actionId]: combo } }),
      resetKeybinds: () => set({ keybindOverrides: {} }),
    }),
    {
      name: 'terminull.prefs',
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        applyTheme(state.theme);
        if (state.locale !== i18n.language) void i18n.changeLanguage(state.locale);
      },
    },
  ),
);
