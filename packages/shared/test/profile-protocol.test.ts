import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROFILE_ID,
  PROFILE_ID_RE,
  ProfileCreateRequestSchema,
  ProfileSwitchRequestSchema,
  ProfilesFileSchema,
  ToolProfileDtoSchema,
  isAbsolutePathname,
} from '../src/index';

const work = {
  id: 'work',
  toolId: 'claude',
  label: 'Work account',
  configHome: '/Users/u/claude-homes/work',
};

describe('ToolProfileDto', () => {
  it('accepts a labelled absolute-path pointer and rejects extras (strict)', () => {
    expect(ToolProfileDtoSchema.parse(work)).toEqual(work);
    expect(ToolProfileDtoSchema.safeParse({ ...work, token: 'x' }).success).toBe(false);
  });

  it('refuses relative config homes — a profile is never a guessable path', () => {
    for (const bad of ['relative/home', './x', '~/claude', '']) {
      expect(ToolProfileDtoSchema.safeParse({ ...work, configHome: bad }).success).toBe(false);
    }
    // Windows absolute is accepted (web bundle cannot use node:path).
    expect(isAbsolutePathname('C:\\Users\\u\\claude')).toBe(true);
    expect(isAbsolutePathname('/home/u')).toBe(true);
    expect(isAbsolutePathname('home/u')).toBe(false);
  });

  it('enforces the profile-id slug rule', () => {
    for (const bad of ['Work', 'a b', '', 'a'.repeat(33), '-lead']) {
      expect(PROFILE_ID_RE.test(bad)).toBe(false);
    }
    expect(PROFILE_ID_RE.test('work-2')).toBe(true);
  });
});

describe('ProfilesFile', () => {
  it('parses a valid registry', () => {
    const file = ProfilesFileSchema.parse({
      version: 1,
      profiles: [work, { ...work, toolId: 'codex', configHome: '/Users/u/codex-homes/work' }],
      active: { claude: 'work' },
    });
    expect(file.profiles).toHaveLength(2);
  });

  it("refuses id 'default' in the registry (implicit real-home profile)", () => {
    const res = ProfilesFileSchema.safeParse({
      version: 1,
      profiles: [{ ...work, id: DEFAULT_PROFILE_ID }],
      active: {},
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.message === 'profile_id_reserved')).toBe(true);
    }
  });

  it('refuses duplicate (toolId, id) pairs but allows the same id across tools', () => {
    const dup = ProfilesFileSchema.safeParse({
      version: 1,
      profiles: [work, { ...work, label: 'Again' }],
      active: {},
    });
    expect(dup.success).toBe(false);
    if (!dup.success) {
      expect(dup.error.issues.some((i) => i.message === 'profile_id_duplicate')).toBe(true);
    }
    const crossTool = ProfilesFileSchema.safeParse({
      version: 1,
      profiles: [work, { ...work, toolId: 'codex' }],
      active: {},
    });
    expect(crossTool.success).toBe(true);
  });

  it('refuses an active pointer at a profile that does not exist', () => {
    const res = ProfilesFileSchema.safeParse({
      version: 1,
      profiles: [work],
      active: { codex: 'ghost' },
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.message === 'active_profile_unknown')).toBe(true);
    }
    // 'default' is always a legal active value, registry entry or not.
    expect(
      ProfilesFileSchema.safeParse({ version: 1, profiles: [], active: { claude: 'default' } })
        .success,
    ).toBe(true);
  });
});

describe('create / switch requests', () => {
  it("create refuses 'default' and switch accepts it", () => {
    expect(
      ProfileCreateRequestSchema.safeParse({ ...work, id: DEFAULT_PROFILE_ID }).success,
    ).toBe(false);
    expect(ProfileCreateRequestSchema.parse(work).id).toBe('work');
    expect(
      ProfileSwitchRequestSchema.parse({ toolId: 'claude', profileId: 'default' }).profileId,
    ).toBe('default');
    expect(
      ProfileSwitchRequestSchema.safeParse({ toolId: 'claude', profileId: 'x', force: 1 }).success,
    ).toBe(false);
  });
});
