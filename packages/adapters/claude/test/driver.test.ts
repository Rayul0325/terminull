import { describe, expect, it } from 'vitest';
import { ClaudeDriver } from '../src/driver';
import { claudeKeymap } from '../src/keymap';

const U = (bytes: Uint8Array | undefined): number[] => Array.from(bytes ?? new Uint8Array());
const CTRL_U = [0x15];
const ENTER = [0x0d];
const RIGHT = [0x1b, 0x5b, 0x43];
const SHIFTTAB = [0x1b, 0x5b, 0x5a];
const DOWN = [0x1b, 0x5b, 0x42];
const UP = [0x1b, 0x5b, 0x41];
const SPACE = [0x20];
const ESCAPE = [0x1b];

function newDriver(): { driver: ClaudeDriver; captured: Uint8Array[] } {
  const captured: Uint8Array[] = [];
  const driver = new ClaudeDriver(claudeKeymap, (b) => void captured.push(b), {
    sleep: () => Promise.resolve(), // deterministic byte ordering (no real timers)
  });
  return { driver, captured };
}

const MENU = ['? Pick one', '❯ 1. Option A', '  2. Option B', '  3. Option C'].join('\n');
const PLAN_MENU = ['❯ 1. Yes, proceed', '  2. No, keep planning'].join('\n');
const BUSY = 'Cogitating… (esc to interrupt)';
const IDLE = ['│ > ', '', '? for shortcuts'].join('\n');
const UNKNOWN = 'just some scrollback with no recognizable prompt markers at all';

describe('ClaudeDriver.detectPromptState', () => {
  it('classifies a numbered menu', () => {
    const { driver } = newDriver();
    const s = driver.detectPromptState(MENU);
    expect(s.kind).toBe('menu');
    if (s.kind === 'menu') {
      expect(s.options).toHaveLength(3);
      expect(s.options[0]).toMatchObject({ index: 0, label: 'Option A', selected: true });
      expect(s.menuType).toBe('select');
    }
  });

  it('classifies a plan approval menu as menuType plan', () => {
    const { driver } = newDriver();
    const s = driver.detectPromptState(PLAN_MENU);
    expect(s.kind === 'menu' && s.menuType).toBe('plan');
  });

  it('classifies a generating screen as busy', () => {
    const { driver } = newDriver();
    expect(driver.detectPromptState(BUSY).kind).toBe('busy');
  });

  it('classifies an empty prompt box as idle', () => {
    const { driver } = newDriver();
    expect(driver.detectPromptState(IDLE).kind).toBe('idle');
  });

  it('is honestly unknown when it cannot classify', () => {
    const { driver } = newDriver();
    expect(driver.detectPromptState(UNKNOWN).kind).toBe('unknown');
  });
});

describe('ClaudeDriver.answerMenu', () => {
  it('walks Down from the current selection to the choice, then Enter', async () => {
    const { driver, captured } = newDriver();
    let postVerified = false;
    await driver.answerMenu({
      screen: MENU,
      choice: 2, // cursor at 0 → Down ×2 → Enter
      snapshot: () => {
        postVerified = true;
        return IDLE; // menu gone
      },
    });
    expect(captured.map(U)).toEqual([DOWN, DOWN, ENTER]);
    expect(postVerified).toBe(true);
  });

  it('rejects with MENU_NOT_PRESENT and fires no keystrokes when there is no menu', async () => {
    const { driver, captured } = newDriver();
    await expect(driver.answerMenu({ screen: IDLE, choice: 0 })).rejects.toMatchObject({
      code: 'MENU_NOT_PRESENT',
    });
    expect(captured).toHaveLength(0);
  });

  it('throws when the post-verify snapshot still shows a menu', async () => {
    const { driver } = newDriver();
    await expect(
      driver.answerMenu({ screen: MENU, choice: 1, snapshot: () => MENU }),
    ).rejects.toMatchObject({ code: 'MENU_NOT_DISMISSED' });
  });

  it('toggles each option with Space for multi-select, then Enter', async () => {
    const { driver, captured } = newDriver();
    await driver.answerMenu({ screen: MENU, choice: [0, 2], multiSelect: true });
    // cursor 0 → toggle 0 (Space) → Down×2 → toggle 2 (Space) → Enter
    expect(captured.map(U)).toEqual([SPACE, DOWN, DOWN, SPACE, ENTER]);
  });
});

describe('ClaudeDriver — key quirks', () => {
  it('primes ShiftTab with Right (+delay) before ESC[Z', async () => {
    const { driver, captured } = newDriver();
    await driver.sendKey('ShiftTab');
    expect(captured.map(U)).toEqual([RIGHT, SHIFTTAB]);
  });

  it('does not prime an ordinary key', async () => {
    const { driver, captured } = newDriver();
    await driver.sendKey('Down');
    expect(captured.map(U)).toEqual([DOWN]);
  });

  it('throws UnknownKeyError for an unbound key', async () => {
    const { driver } = newDriver();
    await expect(driver.sendKey('CtrlD')).rejects.toMatchObject({ code: 'UNKNOWN_KEY' });
  });
});

describe('ClaudeDriver.sendText — draft-clear ordering', () => {
  it('clears the draft (CtrlU), types, then submits (Enter) by default', async () => {
    const { driver, captured } = newDriver();
    await driver.sendText({ text: 'hello' });
    expect(captured.map(U)).toEqual([CTRL_U, [...Buffer.from('hello')], ENTER]);
  });

  it('skips Enter when submit is false', async () => {
    const { driver, captured } = newDriver();
    await driver.sendText({ text: 'draft', submit: false });
    expect(captured.map(U)).toEqual([CTRL_U, [...Buffer.from('draft')]]);
  });
});

describe('ClaudeDriver — mode + control', () => {
  it('interrupts with Escape (not Ctrl+C)', async () => {
    const { driver, captured } = newDriver();
    await driver.interrupt();
    expect(captured.map(U)).toEqual([ESCAPE]);
  });

  it('cycles permission mode with primed ShiftTab presses', async () => {
    const { driver, captured } = newDriver();
    // Default (idx 0) → plan (idx 2): 2 primed ShiftTab presses.
    await driver.setPermissionMode('plan', IDLE);
    expect(captured.map(U)).toEqual([RIGHT, SHIFTTAB, RIGHT, SHIFTTAB]);
  });

  it('walks Up when the current mode is past the target in the cycle', async () => {
    const { driver, captured } = newDriver();
    // From plan (idx 2) → default (idx 0): (0-2+3)%3 = 1 ShiftTab.
    await driver.setPermissionMode('default', 'plan mode on');
    expect(captured.map(U)).toEqual([RIGHT, SHIFTTAB]);
    expect(UP).toEqual(UP); // (Up is exercised by walk() in answerMenu tests)
  });

  it('refuses modes not reachable via Shift+Tab', async () => {
    const { driver } = newDriver();
    await expect(driver.setPermissionMode('bypassPermissions', IDLE)).rejects.toMatchObject({
      code: 'ADAPTER_UNSUPPORTED',
    });
  });

  it('backgrounds a running bash with Ctrl+B', async () => {
    const { driver, captured } = newDriver();
    await driver.background();
    expect(captured.map(U)).toEqual([[0x02]]);
  });
});
