/**
 * Default UI keybindings (the panel's own shortcuts — NOT the per-tool TUI
 * keymaps, which relay through adapter Keymap APIs).
 *
 * Terminal-scope rule (plan §패널 단축키): while focus is inside a
 * `[data-terminull-scope="terminal"]` element, ONLY combos carrying BOTH the
 * primary modifier (mod = ⌘ on macOS, Ctrl elsewhere) AND Alt are eligible —
 * plain keys, Escape, Tab, and single-modifier combos (Ctrl+C!) always reach
 * the PTY untouched. Every default below uses mod+alt so it works everywhere;
 * custom rebinds that drop to a single modifier lose terminal-scope
 * eligibility automatically (enforced in manager.ts, not by convention).
 */

export interface KeyActionDef {
  /** Stable action id ('workspace.nextTab' …). */
  id: string;
  /** i18n key for the settings UI label. */
  labelKey: string;
  /** Default combo in canonical form (see normalizeCombo). */
  combo: string;
}

export const KEY_ACTIONS: readonly KeyActionDef[] = [
  { id: 'workspace.nextTab', labelKey: 'keys.nextTab', combo: 'mod+alt+arrowright' },
  { id: 'workspace.prevTab', labelKey: 'keys.prevTab', combo: 'mod+alt+arrowleft' },
  { id: 'workspace.nextGroup', labelKey: 'keys.nextGroup', combo: 'mod+alt+arrowdown' },
  { id: 'nav.home', labelKey: 'keys.goHome', combo: 'mod+alt+h' },
  { id: 'nav.settings', labelKey: 'keys.goSettings', combo: 'mod+alt+comma' },
];

export const DEFAULT_COMBOS: ReadonlyMap<string, string> = new Map(
  KEY_ACTIONS.map((a) => [a.id, a.combo]),
);
