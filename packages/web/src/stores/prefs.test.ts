/**
 * Prefs keybinding-roaming tests (M9 D6). Merge order under test: the server
 * document seeds the store on connect (server wins), every local edit
 * full-replace PUTs the WHOLE overrides map (never a delta), and a failed
 * round trip surfaces an honest 'error' sync state while the local copy keeps
 * working. Plus the W4 rebind end-to-end: a rebound combo actually fires its
 * action through the KeybindingManager. All fetches mocked.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { setFetchImpl } from '../api/client';
import { KeybindingManager } from '../keybindings/manager';
import { usePrefsStore } from './prefs';

let restoreFetch: (() => void) | null = null;

afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
  usePrefsStore.setState({ keybindOverrides: {}, keybindsSync: 'local', keybindsSyncCode: null });
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Wait for the fire-and-forget PUT inside setKeybindOverride to settle. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('keybinding roaming', () => {
  it('the server document seeds the store on connect (server wins)', async () => {
    usePrefsStore.setState({ keybindOverrides: { 'nav.home': 'mod+alt+x' } });
    restoreFetch = setFetchImpl(() =>
      Promise.resolve(json(200, { version: 1, overrides: { 'workspace.nextTab': 'mod+alt+t' } })),
    );
    await usePrefsStore.getState().loadServerKeybinds();
    expect(usePrefsStore.getState().keybindOverrides).toEqual({ 'workspace.nextTab': 'mod+alt+t' });
    expect(usePrefsStore.getState().keybindsSync).toBe('synced');
  });

  it('a failed GET keeps the local copy and reports an honest error state', async () => {
    usePrefsStore.setState({ keybindOverrides: { 'nav.home': 'mod+alt+x' } });
    restoreFetch = setFetchImpl(() => Promise.resolve(json(500, { code: 'internal' })));
    await usePrefsStore.getState().loadServerKeybinds();
    expect(usePrefsStore.getState().keybindOverrides).toEqual({ 'nav.home': 'mod+alt+x' });
    expect(usePrefsStore.getState().keybindsSync).toBe('error');
    expect(usePrefsStore.getState().keybindsSyncCode).toBe('internal');
  });

  it('a local edit PUTs the WHOLE overrides map (full replace, never a delta)', async () => {
    const puts: Array<[string, string, unknown]> = [];
    restoreFetch = setFetchImpl((url, init) => {
      puts.push([init?.method ?? 'GET', url, JSON.parse(String(init?.body))]);
      return Promise.resolve(json(200, JSON.parse(String(init?.body))));
    });
    usePrefsStore.setState({ keybindOverrides: { 'nav.home': 'mod+alt+x' } });
    usePrefsStore.getState().setKeybindOverride('workspace.nextTab', 'mod+alt+t');
    await settle();
    expect(puts).toEqual([
      [
        'PUT',
        '/api/prefs/keybindings',
        {
          version: 1,
          overrides: { 'nav.home': 'mod+alt+x', 'workspace.nextTab': 'mod+alt+t' },
        },
      ],
    ]);
    expect(usePrefsStore.getState().keybindsSync).toBe('synced');
  });

  it('a failed PUT keeps the local override and flags the sync error', async () => {
    restoreFetch = setFetchImpl(() => Promise.resolve(json(403, { code: 'user_required' })));
    usePrefsStore.getState().setKeybindOverride('nav.home', 'mod+alt+z');
    await settle();
    expect(usePrefsStore.getState().keybindOverrides['nav.home']).toBe('mod+alt+z');
    expect(usePrefsStore.getState().keybindsSync).toBe('error');
    expect(usePrefsStore.getState().keybindsSyncCode).toBe('user_required');
  });
});

describe('rebind end-to-end (W4)', () => {
  it('a rebound workspace.nextTab combo fires the action; the old one goes dead', async () => {
    restoreFetch = setFetchImpl(() => Promise.resolve(json(200, { version: 1, overrides: {} })));
    usePrefsStore.getState().setKeybindOverride('workspace.nextTab', 'mod+alt+t');
    await settle();

    const manager = new KeybindingManager();
    manager.setOverrides(usePrefsStore.getState().keybindOverrides);
    let activeTab = 0;
    manager.register('workspace.nextTab', () => {
      activeTab += 1;
    });

    const fired = manager.dispatch(
      { key: 't', metaKey: true, ctrlKey: false, altKey: true, shiftKey: false },
      { isMac: true },
    );
    expect(fired).toBe('workspace.nextTab');
    expect(activeTab).toBe(1);

    // The default combo no longer routes to the action after the rebind.
    const old = manager.dispatch(
      { key: 'arrowright', metaKey: true, ctrlKey: false, altKey: true, shiftKey: false },
      { isMac: true },
    );
    expect(old).toBeNull();
    expect(activeTab).toBe(1);
  });
});
