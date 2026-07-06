/**
 * Permission-settings round-trip tests: GET seeds rows, a toggle PUTs the
 * contracted {changes} body and adopts the SERVER response (never an
 * optimistic flip), floors are enforced client-side too, and a failed PUT
 * leaves the previous class visible with the machine code surfaced.
 * All fetches are mocked — no server, no real home directory.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { PermissionSettingsDto } from '@terminull/shared';
import { setFetchImpl } from '../api/client';
import { belowFloor, useAgentSettingsStore } from './agentSettings';

let restoreFetch: (() => void) | null = null;

afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
  useAgentSettingsStore.setState({
    settings: null,
    loading: false,
    errorCode: null,
    saveErrorCode: null,
    savingIds: [],
  });
});

function dto(overrides?: Partial<Record<string, unknown>>): PermissionSettingsDto {
  return {
    version: 1,
    actions: [
      {
        id: 'directive.send',
        labelKey: 'perm.directive_send',
        class: 'autonomous',
        defaultClass: 'autonomous',
        risk: 'low',
        requiresTwoStep: false,
      },
      {
        id: 'session.delete',
        labelKey: 'perm.session_delete',
        class: 'confirm',
        defaultClass: 'confirm',
        risk: 'high',
        floor: 'confirm',
        requiresTwoStep: true,
      },
    ],
    ...overrides,
  } as PermissionSettingsDto;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('agent settings store', () => {
  it('GET seeds rows including the session.delete floor', async () => {
    restoreFetch = setFetchImpl(() => Promise.resolve(json(200, dto())));
    await useAgentSettingsStore.getState().load();
    const s = useAgentSettingsStore.getState();
    expect(s.errorCode).toBeNull();
    expect(s.settings?.actions).toHaveLength(2);
    const del = s.settings?.actions.find((a) => a.id === 'session.delete');
    expect(del?.floor).toBe('confirm');
    expect(del?.requiresTwoStep).toBe(true);
  });

  it('setClass PUTs {changes} and adopts the server response (round trip)', async () => {
    const calls: Array<{ method?: string; url: string; body?: unknown }> = [];
    restoreFetch = setFetchImpl((url, init) => {
      calls.push({
        ...(init?.method !== undefined ? { method: init.method } : {}),
        url,
        ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {}),
      });
      if (init?.method === 'PUT') {
        const updated = dto();
        updated.actions[0]!.class = 'confirm';
        return Promise.resolve(json(200, updated));
      }
      return Promise.resolve(json(200, dto()));
    });
    const store = useAgentSettingsStore.getState();
    await store.load();
    await store.setClass('directive.send', 'confirm');
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.url).toBe('/api/agent/permission-settings');
    expect(put?.body).toEqual({ changes: { 'directive.send': 'confirm' } });
    // The visible class is the SERVER's answer, not a local flip.
    const row = useAgentSettingsStore
      .getState()
      .settings?.actions.find((a) => a.id === 'directive.send');
    expect(row?.class).toBe('confirm');
    expect(useAgentSettingsStore.getState().savingIds).toHaveLength(0);
  });

  it('refuses to loosen below the floor without touching the wire', async () => {
    let putCount = 0;
    restoreFetch = setFetchImpl((_url, init) => {
      if (init?.method === 'PUT') putCount += 1;
      return Promise.resolve(json(200, dto()));
    });
    const store = useAgentSettingsStore.getState();
    await store.load();
    await store.setClass('session.delete', 'autonomous');
    expect(putCount).toBe(0);
    const row = useAgentSettingsStore
      .getState()
      .settings?.actions.find((a) => a.id === 'session.delete');
    expect(row?.class).toBe('confirm');
    expect(belowFloor('autonomous', 'confirm')).toBe(true);
    expect(belowFloor('forbidden', 'confirm')).toBe(false);
  });

  it('a failed PUT keeps the previous class and surfaces the code verbatim', async () => {
    restoreFetch = setFetchImpl((_url, init) => {
      if (init?.method === 'PUT') {
        return Promise.resolve(json(403, { code: 'agent_permission_mutation' }));
      }
      return Promise.resolve(json(200, dto()));
    });
    const store = useAgentSettingsStore.getState();
    await store.load();
    await store.setClass('directive.send', 'forbidden');
    const s = useAgentSettingsStore.getState();
    expect(s.saveErrorCode).toBe('agent_permission_mutation');
    expect(s.settings?.actions.find((a) => a.id === 'directive.send')?.class).toBe('autonomous');
    expect(s.savingIds).toHaveLength(0);
  });

  it('a failed GET surfaces the machine code', async () => {
    restoreFetch = setFetchImpl(() => Promise.resolve(json(401, { code: 'auth_required' })));
    await useAgentSettingsStore.getState().load();
    expect(useAgentSettingsStore.getState().errorCode).toBe('auth_required');
    expect(useAgentSettingsStore.getState().settings).toBeNull();
  });
});
