/**
 * Keybinding dispatch layer. Pure logic (no React) so the terminal-scope rule
 * and conflict detection are unit-testable; a thin hook in App wires it to
 * `window.keydown`.
 */
import { DEFAULT_COMBOS, KEY_ACTIONS } from './defaults';

/** The subset of KeyboardEvent the manager reads (test-friendly). */
export interface KeyEventLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  target?: unknown;
}

export const TERMINAL_SCOPE_ATTR = 'data-terminull-scope';

/** Is the event target inside a terminal scope? (DOM-optional for tests.) */
export function inTerminalScope(target: unknown): boolean {
  if (typeof Element === 'undefined' || !(target instanceof Element)) return false;
  return target.closest(`[${TERMINAL_SCOPE_ATTR}="terminal"]`) !== null;
}

/**
 * Canonical combo for a key event: sorted modifiers (`mod` = ⌘ on mac /
 * Ctrl elsewhere) + lowercased key ('comma' for ','). Returns null for a
 * bare-modifier press.
 */
export function normalizeCombo(e: KeyEventLike, isMac: boolean = detectMac()): string | null {
  const key = e.key.toLowerCase();
  if (key === 'meta' || key === 'control' || key === 'alt' || key === 'shift') return null;
  const parts: string[] = [];
  const mod = isMac ? e.metaKey : e.ctrlKey;
  const otherPrimary = isMac ? e.ctrlKey : e.metaKey;
  if (mod) parts.push('mod');
  if (otherPrimary) parts.push(isMac ? 'ctrl' : 'meta');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  parts.push(key === ',' ? 'comma' : key === ' ' ? 'space' : key);
  return parts.join('+');
}

function detectMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform);
}

/** A combo is terminal-eligible iff it carries BOTH mod and alt. */
export function comboAllowedInTerminal(combo: string): boolean {
  const parts = combo.split('+');
  return parts.includes('mod') && parts.includes('alt');
}

export type KeyActionHandler = () => void;

export class KeybindingManager {
  private readonly handlers = new Map<string, KeyActionHandler>();
  private overrides: Record<string, string | null> = {};

  /** Register (or replace) the handler for an action id. Returns unregister. */
  register(actionId: string, handler: KeyActionHandler): () => void {
    this.handlers.set(actionId, handler);
    return () => {
      if (this.handlers.get(actionId) === handler) this.handlers.delete(actionId);
    };
  }

  setOverrides(overrides: Record<string, string | null>): void {
    this.overrides = overrides;
  }

  /** Effective combo for an action (override wins; null = unbound). */
  comboFor(actionId: string): string | null {
    if (actionId in this.overrides) return this.overrides[actionId] ?? null;
    return DEFAULT_COMBOS.get(actionId) ?? null;
  }

  /** combo → actionId map after overrides. */
  private effectiveMap(): Map<string, string> {
    const map = new Map<string, string>();
    for (const def of KEY_ACTIONS) {
      const combo = this.comboFor(def.id);
      // First binding wins on conflict — detectConflicts() surfaces the rest.
      if (combo !== null && !map.has(combo)) map.set(combo, def.id);
    }
    return map;
  }

  /** Groups of action ids sharing one combo (length > 1 = conflict). */
  detectConflicts(): string[][] {
    const byCombo = new Map<string, string[]>();
    for (const def of KEY_ACTIONS) {
      const combo = this.comboFor(def.id);
      if (combo === null) continue;
      byCombo.set(combo, [...(byCombo.get(combo) ?? []), def.id]);
    }
    return [...byCombo.values()].filter((ids) => ids.length > 1);
  }

  /**
   * Dispatch a key event. Returns the fired action id (caller should
   * preventDefault) or null when the event must pass through — ALWAYS null
   * for terminal-scoped events whose combo is not mod+alt. `opts.inTerminal`
   * overrides the DOM scope probe (tests / non-DOM environments).
   */
  dispatch(e: KeyEventLike, opts: { isMac?: boolean; inTerminal?: boolean } = {}): string | null {
    const combo = normalizeCombo(e, opts.isMac);
    if (combo === null) return null;
    const inTerminal = opts.inTerminal ?? inTerminalScope(e.target);
    if (inTerminal && !comboAllowedInTerminal(combo)) return null;
    const actionId = this.effectiveMap().get(combo);
    if (!actionId) return null;
    const handler = this.handlers.get(actionId);
    if (!handler) return null;
    handler();
    return actionId;
  }
}

/** App-wide singleton (components register/unregister through it). */
export const keybindings = new KeybindingManager();
