/**
 * Profile-registry store tests (M9 W1 / oracle d, UI half). The contract
 * behaviours: `/api/profiles` seeds list+active, create/delete mutate the
 * registry only, and switchTo records the SERVER's `liveSessionCount`
 * verbatim (the honest live-session warning source) while never touching any
 * session. Machine error codes (409 duplicate, 422 profile_unsupported) pass
 * through untranslated. All fetches mocked; no real homes, no credentials.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { setFetchImpl } from '../api/client';
import { activeProfileOf, profilesForTool, useProfilesStore } from './profiles';

let restoreFetch: (() => void) | null = null;

afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
  useProfilesStore.setState({
    profiles: [],
    active: {},
    loaded: false,
    loading: false,
    errorCode: null,
    lastSwitch: null,
  });
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const WORK = { id: 'work', toolId: 'claude', label: '업무 계정', configHome: '/fake/claude-work' };

describe('profiles store', () => {
  it('load seeds profiles + active from /api/profiles', async () => {
    restoreFetch = setFetchImpl(() =>
      Promise.resolve(json(200, { version: 1, profiles: [WORK], active: { claude: 'work' } })),
    );
    await useProfilesStore.getState().load();
    expect(useProfilesStore.getState().profiles).toEqual([WORK]);
    expect(activeProfileOf(useProfilesStore.getState().active, 'claude')).toBe('work');
    // A tool with no active entry is on the implicit default.
    expect(activeProfileOf(useProfilesStore.getState().active, 'codex')).toBe('default');
  });

  it('create appends on 201 and passes the 409 duplicate code through', async () => {
    restoreFetch = setFetchImpl((url, init) =>
      Promise.resolve(
        init?.method === 'POST'
          ? json(201, { created: true, profile: WORK })
          : json(200, { version: 1, profiles: [], active: {} }),
      ),
    );
    expect(await useProfilesStore.getState().create(WORK)).toBeNull();
    expect(useProfilesStore.getState().profiles).toEqual([WORK]);

    restoreFetch();
    restoreFetch = setFetchImpl(() => Promise.resolve(json(409, { code: 'profile_id_duplicate' })));
    expect(await useProfilesStore.getState().create(WORK)).toBe('profile_id_duplicate');
  });

  it('switchTo records the SERVER liveSessionCount verbatim and updates active', async () => {
    restoreFetch = setFetchImpl(() =>
      Promise.resolve(
        json(200, { switched: true, toolId: 'claude', profileId: 'work', liveSessionCount: 3 }),
      ),
    );
    useProfilesStore.setState({ profiles: [WORK] });
    const code = await useProfilesStore.getState().switchTo('claude', 'work');
    expect(code).toBeNull();
    expect(useProfilesStore.getState().active).toEqual({ claude: 'work' });
    expect(useProfilesStore.getState().lastSwitch?.liveSessionCount).toBe(3);
  });

  it('switching back to default clears the active entry', async () => {
    restoreFetch = setFetchImpl(() =>
      Promise.resolve(
        json(200, { switched: true, toolId: 'claude', profileId: 'default', liveSessionCount: 0 }),
      ),
    );
    useProfilesStore.setState({ active: { claude: 'work' } });
    await useProfilesStore.getState().switchTo('claude', 'default');
    expect(useProfilesStore.getState().active).toEqual({});
  });

  it('a 422 profile_unsupported switch is an honest error code, state untouched', async () => {
    restoreFetch = setFetchImpl(() => Promise.resolve(json(422, { code: 'profile_unsupported' })));
    const code = await useProfilesStore.getState().switchTo('agy', 'work');
    expect(code).toBe('profile_unsupported');
    expect(useProfilesStore.getState().active).toEqual({});
    expect(useProfilesStore.getState().lastSwitch).toBeNull();
  });

  it('remove deletes the registry entry and its active mapping (default fallback)', async () => {
    restoreFetch = setFetchImpl(() => Promise.resolve(json(200, { deleted: true })));
    useProfilesStore.setState({ profiles: [WORK], active: { claude: 'work' } });
    expect(await useProfilesStore.getState().remove('claude', 'work')).toBeNull();
    expect(useProfilesStore.getState().profiles).toEqual([]);
    expect(activeProfileOf(useProfilesStore.getState().active, 'claude')).toBe('default');
  });

  it('profilesForTool filters by tool', () => {
    const codex = { ...WORK, id: 'alt', toolId: 'codex' };
    expect(profilesForTool([WORK, codex], 'claude')).toEqual([WORK]);
  });
});
