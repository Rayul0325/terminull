/**
 * Layout store tests over a mocked in-memory idb-keyval: save/delete
 * templates, per-project default resolution (project → global), and the
 * dangling-default cleanup on delete.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mem = new Map<string, unknown>();
vi.mock('idb-keyval', () => ({
  get: (key: string) => Promise.resolve(mem.get(key)),
  set: (key: string, value: unknown) => {
    mem.set(key, value);
    return Promise.resolve();
  },
  del: (key: string) => {
    mem.delete(key);
    return Promise.resolve();
  },
}));

import { loadLastLayout, saveLastLayout, useLayoutStore } from './layout';

beforeEach(() => {
  mem.clear();
  useLayoutStore.setState({ loaded: false, templates: {}, defaults: {} });
});

describe('layout templates', () => {
  it('saves and reloads templates through idb', async () => {
    await useLayoutStore.getState().saveTemplate('my-setup', { grid: 1 });
    useLayoutStore.setState({ loaded: false, templates: {}, defaults: {} });
    await useLayoutStore.getState().load();
    const tpl = useLayoutStore.getState().templates['my-setup'];
    expect(tpl).toBeDefined();
    expect(tpl!.version).toBe(1);
    expect(tpl!.layout).toEqual({ grid: 1 });
  });

  it('resolves the default template project-first, then global', async () => {
    const store = useLayoutStore.getState();
    await store.setDefault('*', 'chat');
    await store.setDefault('proj-a', 'ide');
    expect(useLayoutStore.getState().defaultFor('proj-a')).toBe('ide');
    expect(useLayoutStore.getState().defaultFor('proj-b')).toBe('chat');
  });

  it('deleting a template clears defaults that pointed at it', async () => {
    const store = useLayoutStore.getState();
    await store.saveTemplate('temp', { x: 1 });
    await store.setDefault('proj-a', 'temp');
    await store.deleteTemplate('temp');
    expect(useLayoutStore.getState().templates['temp']).toBeUndefined();
    expect(useLayoutStore.getState().defaultFor('proj-a')).toBeUndefined();
  });

  it('persists and reloads the last-used layout per project', async () => {
    await saveLastLayout('proj-a', { panels: ['a'] });
    expect(await loadLastLayout('proj-a')).toEqual({ panels: ['a'] });
    expect(await loadLastLayout('proj-b')).toBeUndefined();
  });
});
