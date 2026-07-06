import { describe, expect, it } from 'vitest';
import {
  CUSTOM_HARNESS_MAX_ITEMS,
  CustomHarnessGroupDtoSchema,
  HARNESS_BACKUP_ROTATION,
  HARNESS_FILE_ID_RE,
  HARNESS_MAX_CONTENT_BYTES,
  HarnessBackupDtoSchema,
  HarnessFileDtoSchema,
  HarnessGroupDtoSchema,
  HarnessReadDtoSchema,
  HarnessRestoreRequestSchema,
  HarnessWriteRequestSchema,
  HarnessWriteResponseSchema,
  KEYBINDINGS_MAX_ENTRIES,
  KeybindingsDtoSchema,
  SessionStatusDtoSchema,
  isPostable,
} from '../src/index';

const SHA = 'a'.repeat(64);

describe('HARNESS_FILE_ID_RE', () => {
  it('accepts catalog-style ids and refuses path-capable ones', () => {
    for (const ok of ['claude.settings', 'codex.config', 'claude.md.global', 'agy.gemini.md']) {
      expect(HARNESS_FILE_ID_RE.test(ok)).toBe(true);
    }
    // Backup dirs are named after fileId — separators and traversal must die here.
    for (const bad of ['../etc', 'a/b', 'a\\b', '.hidden', 'UPPER', '', 'a'.repeat(65)]) {
      expect(HARNESS_FILE_ID_RE.test(bad)).toBe(false);
    }
  });
});

describe('HarnessFileDto / HarnessGroupDto', () => {
  const file = {
    id: 'claude.settings',
    toolId: 'claude',
    label: { en: 'Global settings.json', ko: '전역 settings.json' },
    description: { en: 'User settings', ko: '사용자 설정' },
    format: 'json',
    scope: 'user',
    riskLevel: 'high',
    path: '/home/u/.claude/settings.json',
    exists: true,
    mayNotExist: true,
  };

  it('accepts a manifest entry and rejects unknown keys (strict)', () => {
    expect(HarnessFileDtoSchema.parse(file)).toEqual(file);
    expect(HarnessFileDtoSchema.safeParse({ ...file, extra: 1 }).success).toBe(false);
  });

  it('requires both label locales (LocalizedText contract)', () => {
    expect(HarnessFileDtoSchema.safeParse({ ...file, label: { en: 'only english' } }).success).toBe(
      false,
    );
  });

  it('groups carry a toolId + displayName', () => {
    const group = {
      toolId: 'claude',
      displayName: { en: 'Claude Code', ko: 'Claude Code' },
      files: [file],
    };
    expect(HarnessGroupDtoSchema.parse(group).files).toHaveLength(1);
  });
});

describe('read / write / backups wire shapes', () => {
  it('read of an absent file is exists:false with null content/sha (honest)', () => {
    const dto = HarnessReadDtoSchema.parse({
      fileId: 'claude.md.global',
      toolId: 'claude',
      path: '/home/u/.claude/CLAUDE.md',
      exists: false,
      content: null,
      sha: null,
      size: null,
      mtime: null,
    });
    expect(dto.exists).toBe(false);
    expect(dto.sha).toBeNull();
  });

  it('write request takes expectedSha (nullable) + content; rejects extras', () => {
    expect(HarnessWriteRequestSchema.parse({ expectedSha: null, content: '# hi' })).toEqual({
      expectedSha: null,
      content: '# hi',
    });
    expect(
      HarnessWriteRequestSchema.safeParse({ expectedSha: 'not-a-sha', content: '' }).success,
    ).toBe(false);
    expect(
      HarnessWriteRequestSchema.safeParse({ expectedSha: SHA, content: '', force: true }).success,
    ).toBe(false);
  });

  it('write response pins written:true + sha + nullable backupId + validation', () => {
    const res = HarnessWriteResponseSchema.parse({
      written: true,
      fileId: 'claude.settings',
      sha: SHA,
      backupId: null,
      validation: 'full',
    });
    expect(res.backupId).toBeNull();
    expect(
      HarnessWriteResponseSchema.safeParse({
        written: true,
        fileId: 'claude.settings',
        sha: SHA,
        backupId: null,
        validation: 'perfect', // not a member — honesty enum is closed
      }).success,
    ).toBe(false);
  });

  it('backup + restore shapes parse; rotation constant is 20', () => {
    expect(HARNESS_BACKUP_ROTATION).toBe(20);
    expect(
      HarnessBackupDtoSchema.parse({
        backupId: '1720000000000-abcdef12',
        ts: 1,
        sha: SHA,
        bytes: 0,
      }).backupId,
    ).toBe('1720000000000-abcdef12');
    expect(
      HarnessRestoreRequestSchema.parse({ backupId: 'b1', expectedSha: null }).expectedSha,
    ).toBeNull();
  });

  it('caps content size at HARNESS_MAX_CONTENT_BYTES', () => {
    expect(
      HarnessWriteRequestSchema.safeParse({
        expectedSha: null,
        content: 'x'.repeat(HARNESS_MAX_CONTENT_BYTES + 1),
      }).success,
    ).toBe(false);
  });
});

describe('CustomHarnessGroupDto (내 커스텀, read-only detection)', () => {
  it('parses a scan result and enforces the item cap', () => {
    const group = {
      id: 'custom',
      scannedAt: 1720000000000,
      items: [
        {
          kind: 'hook',
          toolId: 'claude',
          path: '/home/u/.claude/settings.json',
          label: 'PostToolUse',
          detail: 'format-track.sh',
        },
        { kind: 'statusline', toolId: 'claude', path: '/home/u/.claude/settings.json' },
        { kind: 'skill', toolId: 'claude', path: '/home/u/.claude/skills/html-report' },
      ],
      truncated: false,
    };
    expect(CustomHarnessGroupDtoSchema.parse(group).items).toHaveLength(3);
    const over = {
      ...group,
      items: Array.from({ length: CUSTOM_HARNESS_MAX_ITEMS + 1 }, (_, i) => ({
        kind: 'other' as const,
        toolId: 'claude',
        path: `/x/${i}`,
      })),
      truncated: true,
    };
    expect(CustomHarnessGroupDtoSchema.safeParse(over).success).toBe(false);
  });
});

describe('SessionStatusDto (GUI statusbar)', () => {
  it('accepts a full snapshot and an all-null honest one', () => {
    const full = SessionStatusDtoSchema.parse({
      toolId: 'claude',
      toolSessionId: 'sess-1',
      model: { id: 'claude-opus-4-8', label: 'Opus 4.8' },
      contextTokens: { used: 61234, max: 200000, usedPercent: 30.6 },
      costUsd: 1.42,
      asOf: 1720000000000,
    });
    expect(full.contextTokens?.max).toBe(200000);
    const empty = SessionStatusDtoSchema.parse({
      toolId: 'codex',
      toolSessionId: 's2',
      model: null,
      contextTokens: null,
      costUsd: null,
      asOf: null,
    });
    expect(empty.model).toBeNull();
  });

  it('refuses fabricated shapes: negative cost, zero-max window, extras', () => {
    const base = {
      toolId: 'claude',
      toolSessionId: 's',
      model: null,
      contextTokens: null,
      costUsd: null,
      asOf: null,
    };
    expect(SessionStatusDtoSchema.safeParse({ ...base, costUsd: -1 }).success).toBe(false);
    expect(
      SessionStatusDtoSchema.safeParse({
        ...base,
        contextTokens: { used: 1, max: 0, usedPercent: 0 },
      }).success,
    ).toBe(false);
    expect(SessionStatusDtoSchema.safeParse({ ...base, vibes: 'good' }).success).toBe(false);
  });

  it('session.status is hook-postable; harness writes are guarded', () => {
    expect(isPostable('session.status')).toBe(true);
    expect(isPostable('harness.file_written')).toBe(false);
    expect(isPostable('harness.file_restored')).toBe(false);
    expect(isPostable('prefs.keybindings_changed')).toBe(false);
  });
});

describe('KeybindingsDto', () => {
  it('accepts overrides with null (unbound) values; combos stay opaque', () => {
    const dto = KeybindingsDtoSchema.parse({
      version: 1,
      overrides: { 'workspace.nextTab': 'mod+alt+bracketright', 'nav.home': null },
    });
    expect(dto.overrides['nav.home']).toBeNull();
  });

  it('rejects bad action ids, oversized combos, and oversized documents', () => {
    expect(
      KeybindingsDtoSchema.safeParse({ version: 1, overrides: { '../x': 'mod+a' } }).success,
    ).toBe(false);
    expect(
      KeybindingsDtoSchema.safeParse({
        version: 1,
        overrides: { 'nav.home': 'x'.repeat(65) },
      }).success,
    ).toBe(false);
    const big: Record<string, string> = {};
    for (let i = 0; i <= KEYBINDINGS_MAX_ENTRIES; i++) big[`a.k${i}`] = 'mod+alt+a';
    expect(KeybindingsDtoSchema.safeParse({ version: 1, overrides: big }).success).toBe(false);
  });
});
