import { describe, expect, it } from 'vitest';
import { AgyPtyDriver, buildAgyOneshotCommand } from '../src/driver';
import { agyKeymap } from '../src/keymap';

const U = (bytes: Uint8Array | undefined): number[] => Array.from(bytes ?? new Uint8Array());
const ENTER = [0x0d];
const CTRLC = [0x03];

function newDriver(): { driver: AgyPtyDriver; captured: Uint8Array[] } {
  const captured: Uint8Array[] = [];
  const driver = new AgyPtyDriver(agyKeymap, (b) => void captured.push(b));
  return { driver, captured };
}

describe('buildAgyOneshotCommand — headless directive assembly', () => {
  it('builds a bare one-shot: agy -p <text>', () => {
    const c = buildAgyOneshotCommand({ text: 'hello world' });
    expect(c.cmd).toBe('agy');
    expect(c.args).toEqual(['-p', 'hello world']);
  });

  it('includes --conversation and --print-timeout for a directive to an existing session', () => {
    const c = buildAgyOneshotCommand({
      text: 'continue please',
      conversationId: '11111111-1111-4111-8111-111111111111',
      printTimeout: '30s',
    });
    expect(c.args).toEqual([
      '-p',
      'continue please',
      '--conversation',
      '11111111-1111-4111-8111-111111111111',
      '--print-timeout',
      '30s',
    ]);
  });

  it('passes text as a single argv element (spaces/quotes preserved, never shell-split)', () => {
    const tricky = 'say "hi there" & do $STUFF';
    const c = buildAgyOneshotCommand({ text: tricky });
    expect(c.args[1]).toBe(tricky);
    expect(c.args).toHaveLength(2);
  });

  it('appends --model and extraArgs in a stable order, honours a custom binary', () => {
    const c = buildAgyOneshotCommand({
      text: 'x',
      conversationId: 'cid',
      printTimeout: '1m',
      model: 'gemini-x',
      cmd: '/opt/agy',
      extraArgs: ['--sandbox'],
    });
    expect(c.cmd).toBe('/opt/agy');
    expect(c.args).toEqual([
      '-p',
      'x',
      '--conversation',
      'cid',
      '--print-timeout',
      '1m',
      '--model',
      'gemini-x',
      '--sandbox',
    ]);
  });
});

describe('AgyPtyDriver — PTY fallback bytes', () => {
  it('types text then submits with a trailing Enter (0x0d)', async () => {
    const { driver, captured } = newDriver();
    await driver.sendText({ text: 'hi', submit: true });
    expect(captured).toHaveLength(2);
    expect(new TextDecoder().decode(captured[0])).toBe('hi');
    expect(U(captured[1])).toEqual(ENTER);
  });

  it('does not submit when submit is falsy', async () => {
    const { driver, captured } = newDriver();
    await driver.sendText({ text: 'draft' });
    expect(captured).toHaveLength(1);
    expect(new TextDecoder().decode(captured[0])).toBe('draft');
  });

  it('emits the bound bytes for a named key', async () => {
    const { driver, captured } = newDriver();
    await driver.sendKey('Down');
    expect(U(captured[0])).toEqual([0x1b, 0x5b, 0x42]);
  });

  it('throws UnknownKeyError for an unbound key', async () => {
    const { driver } = newDriver();
    await expect(driver.sendKey('CtrlD')).rejects.toMatchObject({ code: 'UNKNOWN_KEY' });
  });

  it('interrupts with Ctrl+C (0x03)', async () => {
    const { driver, captured } = newDriver();
    await driver.interrupt();
    expect(U(captured[0])).toEqual(CTRLC);
  });
});

describe('AgyPtyDriver — honest unsupported surface', () => {
  it('detectPromptState is always unknown', () => {
    const { driver } = newDriver();
    expect(driver.detectPromptState('anything at all on the screen').kind).toBe('unknown');
  });

  it('answerMenu refuses with MENU_NOT_PRESENT and fires no keystrokes', async () => {
    const { driver, captured } = newDriver();
    await expect(driver.answerMenu({ screen: 'whatever', choice: 0 })).rejects.toMatchObject({
      code: 'MENU_NOT_PRESENT',
    });
    expect(captured).toHaveLength(0);
  });

  it('approvePlan / setPermissionMode / background / rename throw ADAPTER_UNSUPPORTED', async () => {
    const { driver } = newDriver();
    await expect(driver.approvePlan('s')).rejects.toMatchObject({ code: 'ADAPTER_UNSUPPORTED' });
    await expect(driver.setPermissionMode('skip-permissions', 's')).rejects.toMatchObject({
      code: 'ADAPTER_UNSUPPORTED',
    });
    await expect(driver.background()).rejects.toMatchObject({ code: 'ADAPTER_UNSUPPORTED' });
    await expect(driver.rename('new title')).rejects.toMatchObject({ code: 'ADAPTER_UNSUPPORTED' });
  });
});

describe('agy keymap completeness', () => {
  it('every entry has en+ko labels and non-empty bytes', () => {
    const entries = Object.entries(agyKeymap);
    expect(entries.length).toBeGreaterThan(0);
    for (const [key, binding] of entries) {
      expect(binding, key).toBeDefined();
      expect(binding?.label.en.length, `${key}.en`).toBeGreaterThan(0);
      expect(binding?.label.ko.length, `${key}.ko`).toBeGreaterThan(0);
      expect(binding?.bytes.length, `${key}.bytes`).toBeGreaterThan(0);
    }
  });
});
