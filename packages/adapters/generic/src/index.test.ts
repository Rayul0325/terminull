import { describe, expect, it } from 'vitest';
import { PluginHost, runAdapterConformance } from '@terminull/adapter-sdk';
import * as adapterModule from './adapter';
import { GenericPtyDriver, createGenericAdapter } from './adapter';
import { genericKeymap } from './keymap';
import { manifest } from './manifest';

function newDriver(): { driver: GenericPtyDriver; captured: Uint8Array[] } {
  const captured: Uint8Array[] = [];
  const driver = new GenericPtyDriver(genericKeymap, (bytes) => {
    captured.push(bytes);
  });
  return { driver, captured };
}

describe('GenericPtyDriver — key injection', () => {
  it('emits 0x02 for CtrlB via the injector', async () => {
    const { driver, captured } = newDriver();
    await driver.sendKey('CtrlB');
    expect(captured).toHaveLength(1);
    expect(Array.from(captured[0] ?? new Uint8Array())).toEqual([0x02]);
  });

  it('types text and submits with a trailing Enter (0x0d)', async () => {
    const { driver, captured } = newDriver();
    await driver.sendText({ text: 'hi', submit: true });
    expect(captured).toHaveLength(2);
    expect(new TextDecoder().decode(captured[0])).toBe('hi');
    expect(Array.from(captured[1] ?? new Uint8Array())).toEqual([0x0d]);
  });

  it('interrupts with Ctrl+C (0x03)', async () => {
    const { driver, captured } = newDriver();
    await driver.interrupt();
    expect(Array.from(captured[0] ?? new Uint8Array())).toEqual([0x03]);
  });

  it('throws UnknownKeyError for a key it does not bind', async () => {
    const { driver } = newDriver();
    await expect(driver.sendKey('CtrlD')).rejects.toMatchObject({ code: 'UNKNOWN_KEY' });
  });
});

describe('GenericPtyDriver — answerMenu safety', () => {
  it('rejects with a typed menu-not-present error and fires no keystrokes', async () => {
    const { driver, captured } = newDriver();
    await expect(driver.answerMenu({ screen: 'any output', choice: 0 })).rejects.toMatchObject({
      code: 'MENU_NOT_PRESENT',
    });
    expect(captured).toHaveLength(0);
  });

  it('always reports prompt state as unknown (honest)', () => {
    const { driver } = newDriver();
    expect(driver.detectPromptState('whatever the screen shows').kind).toBe('unknown');
  });
});

describe('generic keymap completeness', () => {
  it('every entry has en+ko labels and non-empty bytes', () => {
    const entries = Object.entries(genericKeymap);
    expect(entries.length).toBeGreaterThan(0);
    for (const [key, binding] of entries) {
      expect(binding, key).toBeDefined();
      expect(binding?.label.en.length, `${key}.en`).toBeGreaterThan(0);
      expect(binding?.label.ko.length, `${key}.ko`).toBeGreaterThan(0);
      expect(binding?.bytes.length, `${key}.bytes`).toBeGreaterThan(0);
    }
  });
});

describe('createGenericAdapter — probe', () => {
  it('reports present when the binary resolves', async () => {
    const adapter = createGenericAdapter();
    const result = await adapter.probe({ cmd: 'toolx', which: () => '/usr/local/bin/toolx' });
    expect(result.present).toBe(true);
  });

  it('reports absent when the binary does not resolve', async () => {
    const adapter = createGenericAdapter();
    const result = await adapter.probe({ cmd: 'toolx', which: () => null });
    expect(result.present).toBe(false);
  });

  it('reports absent when no command is configured', async () => {
    const adapter = createGenericAdapter();
    const result = await adapter.probe({});
    expect(result.present).toBe(false);
  });
});

describe('dogfooding — generic registers through PluginHost and passes conformance', () => {
  const resolver = (p: string): unknown => (p === './adapter.js' ? adapterModule : undefined);

  it('registers cleanly and loads the adapter', () => {
    const host = new PluginHost();
    const res = host.register(manifest, resolver);
    expect(res.ok).toBe(true);
    expect(res.adaptersRegistered).toBe(1);

    host.instantiateAll();
    expect(host.disabled()).toHaveLength(0);

    const lazy = host.adapters().get('generic-pty');
    expect(lazy).toBeDefined();
    expect(lazy?.load().id).toBe('generic-pty');
    expect(lazy?.displayName).toEqual({ en: 'Generic CLI', ko: '일반 CLI' });

    // The keymap contribution is stored as validated metadata for later consumers.
    expect(host.contributions('keymaps').some((c) => c.id === 'generic-default')).toBe(true);
  });

  it('the loaded generic adapter passes the conformance runner', async () => {
    const host = new PluginHost();
    host.register(manifest, resolver);
    host.instantiateAll();
    const adapter = host.adapters().get('generic-pty')?.load();
    expect(adapter).toBeDefined();

    const result = await runAdapterConformance(adapter!, {
      probeContext: { cmd: 'node', which: () => '/usr/bin/node' },
      collectContext: {},
    });
    expect(result.failures).toHaveLength(0);
    expect(result.pass).toBe(true);
  });
});
