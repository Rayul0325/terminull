/**
 * Keybinding layer tests: combo normalization (mac/non-mac), the terminal
 * scope rule (mod+alt-only inside terminals — Ctrl+C must NEVER be
 * intercepted), overrides, and conflict detection.
 */
import { describe, expect, it } from 'vitest';
import {
  KeybindingManager,
  comboAllowedInTerminal,
  normalizeCombo,
  type KeyEventLike,
} from './manager';

function ev(partial: Partial<KeyEventLike> & Pick<KeyEventLike, 'key'>): KeyEventLike {
  return { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...partial };
}

describe('normalizeCombo', () => {
  it('maps the platform primary modifier to mod', () => {
    expect(normalizeCombo(ev({ key: 'ArrowRight', metaKey: true, altKey: true }), true)).toBe(
      'mod+alt+arrowright',
    );
    expect(normalizeCombo(ev({ key: 'ArrowRight', ctrlKey: true, altKey: true }), false)).toBe(
      'mod+alt+arrowright',
    );
  });

  it('returns null for bare modifier presses', () => {
    expect(normalizeCombo(ev({ key: 'Meta', metaKey: true }), true)).toBeNull();
  });

  it('normalizes punctuation keys', () => {
    expect(normalizeCombo(ev({ key: ',', metaKey: true, altKey: true }), true)).toBe(
      'mod+alt+comma',
    );
  });
});

describe('terminal scope rule', () => {
  it('only mod+alt combos are terminal-eligible', () => {
    expect(comboAllowedInTerminal('mod+alt+arrowright')).toBe(true);
    expect(comboAllowedInTerminal('mod+k')).toBe(false);
    expect(comboAllowedInTerminal('ctrl+c')).toBe(false);
  });

  it('dispatch fires mod+alt in terminal scope but never single-modifier combos', () => {
    const manager = new KeybindingManager();
    let fired = 0;
    manager.register('workspace.nextTab', () => fired++);
    // mod+alt combo fires inside a terminal.
    const hit = manager.dispatch(ev({ key: 'ArrowRight', metaKey: true, altKey: true }), {
      isMac: true,
      inTerminal: true,
    });
    expect(hit).toBe('workspace.nextTab');
    expect(fired).toBe(1);
    // Rebind to a single-modifier combo → refused in terminal scope (goes to PTY)…
    manager.setOverrides({ 'workspace.nextTab': 'mod+j' });
    const refused = manager.dispatch(ev({ key: 'j', metaKey: true }), {
      isMac: true,
      inTerminal: true,
    });
    expect(refused).toBeNull();
    expect(fired).toBe(1);
    // …but still fires outside the terminal.
    const outside = manager.dispatch(ev({ key: 'j', metaKey: true }), {
      isMac: true,
      inTerminal: false,
    });
    expect(outside).toBe('workspace.nextTab');
  });

  it('Ctrl+C is never intercepted in terminal scope even if bound', () => {
    const manager = new KeybindingManager();
    let fired = 0;
    manager.register('nav.home', () => fired++);
    manager.setOverrides({ 'nav.home': 'mod+c' });
    const result = manager.dispatch(ev({ key: 'c', ctrlKey: true }), {
      isMac: false,
      inTerminal: true,
    });
    expect(result).toBeNull();
    expect(fired).toBe(0);
  });
});

describe('overrides + conflicts', () => {
  it('override wins and null unbinds', () => {
    const manager = new KeybindingManager();
    expect(manager.comboFor('workspace.nextTab')).toBe('mod+alt+arrowright');
    manager.setOverrides({ 'workspace.nextTab': 'mod+alt+n' });
    expect(manager.comboFor('workspace.nextTab')).toBe('mod+alt+n');
    manager.setOverrides({ 'workspace.nextTab': null });
    expect(manager.comboFor('workspace.nextTab')).toBeNull();
  });

  it('detects two actions sharing one combo', () => {
    const manager = new KeybindingManager();
    manager.setOverrides({ 'workspace.prevTab': 'mod+alt+arrowright' });
    const conflicts = manager.detectConflicts();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toEqual(
      expect.arrayContaining(['workspace.nextTab', 'workspace.prevTab']),
    );
  });
});
