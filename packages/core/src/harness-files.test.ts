/**
 * HarnessFileEngine pipeline unit tests (M9 S1) — every root is a fresh
 * mkdtemp fake home under os.tmpdir(); nothing touches the real ~/.claude or
 * any other real harness path.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BackupNotFoundError,
  FileTooLargeError,
  HarnessFileEngine,
  ParseInvalidError,
  PathJailError,
  ShaMismatchError,
  assertInsideRoots,
  contentSha,
  jsonValidator,
  tomlLintValidator,
  validatorForFormat,
} from './harness-files.js';

let tmp: string;
let home: string;
let engine: HarnessFileEngine;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-hf-'));
  home = path.join(tmp, 'home');
  fs.mkdirSync(home, { recursive: true });
  engine = new HarnessFileEngine({
    backupsDir: path.join(tmp, 'backups'),
    jailRoots: [home],
  });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const target = (): string => path.join(home, '.claude', 'settings.json');

describe('pure helpers', () => {
  it('assertInsideRoots accepts in-jail paths and rejects escapes', () => {
    expect(() => assertInsideRoots(path.join(home, 'a', 'b'), [home])).not.toThrow();
    expect(() => assertInsideRoots(home, [home])).not.toThrow();
    expect(() => assertInsideRoots(path.join(home, '..', 'evil'), [home])).toThrow(PathJailError);
    expect(() => assertInsideRoots('/etc/passwd', [home])).toThrow(PathJailError);
    // Sibling-prefix trap: /x/homeevil is NOT inside /x/home.
    expect(() => assertInsideRoots(`${home}evil/f`, [home])).toThrow(PathJailError);
  });

  it('jsonValidator = full parse; tomlLintValidator = structural lint', () => {
    expect(jsonValidator('{"a":1}')).toBeNull();
    expect(jsonValidator('{"hooks": {')?.detail).toBeTruthy();
    expect(tomlLintValidator('a = 1\n[table]\nb = "x"')).toBeNull();
    expect(tomlLintValidator('just words')).toMatchObject({ line: 1 });
    expect(tomlLintValidator('a = "unterminated')).toMatchObject({ line: 1 });
    expect(validatorForFormat('json').level).toBe('full');
    expect(validatorForFormat('toml').level).toBe('lint');
    expect(validatorForFormat('markdown').level).toBe('none');
  });
});

describe('HarnessFileEngine.write pipeline', () => {
  it('creates (expectedSha null), then updates with a backup of the previous content', async () => {
    const a = await engine.write('claude.settings', target(), {
      expectedSha: null,
      content: '{"a":1}',
      format: 'json',
    });
    expect(a.backupId).toBeNull(); // new file — nothing to back up
    expect(a.sha).toBe(contentSha('{"a":1}'));
    expect(a.validation).toBe('full');
    expect(fs.readFileSync(target(), 'utf8')).toBe('{"a":1}');
    // New files land 0600.
    expect(fs.statSync(target()).mode & 0o777).toBe(0o600);

    const b = await engine.write('claude.settings', target(), {
      expectedSha: a.sha,
      content: '{"a":2}',
      format: 'json',
    });
    expect(b.backupId).toMatch(/^\d+-[0-9a-f]{12}\.bak$/);
    const backups = await engine.listBackups('claude.settings');
    expect(backups).toHaveLength(1);
    expect(backups[0]?.sha).toBe(contentSha('{"a":1}'));
  });

  it('stale expectedSha → ShaMismatchError carrying the CURRENT sha; no mutation', async () => {
    await engine.write('claude.settings', target(), {
      expectedSha: null,
      content: '{"v":1}',
      format: 'json',
    });
    const before = fs.readFileSync(target());
    await expect(
      engine.write('claude.settings', target(), {
        expectedSha: contentSha('something else'),
        content: '{"v":2}',
        format: 'json',
      }),
    ).rejects.toMatchObject({ code: 'sha_mismatch', currentSha: contentSha('{"v":1}') });
    expect(fs.readFileSync(target()).equals(before)).toBe(true);
    // expectedSha null on an EXISTING file = "must not exist" → same 409 path.
    await expect(
      engine.write('claude.settings', target(), {
        expectedSha: null,
        content: '{}',
        format: 'json',
      }),
    ).rejects.toBeInstanceOf(ShaMismatchError);
  });

  it('parse-invalid json → ParseInvalidError; file untouched, no backup consumed', async () => {
    await engine.write('claude.settings', target(), {
      expectedSha: null,
      content: '{"ok":true}',
      format: 'json',
    });
    await expect(
      engine.write('claude.settings', target(), {
        expectedSha: contentSha('{"ok":true}'),
        content: '{"hooks": {',
        format: 'json',
      }),
    ).rejects.toBeInstanceOf(ParseInvalidError);
    expect(fs.readFileSync(target(), 'utf8')).toBe('{"ok":true}');
    expect(await engine.listBackups('claude.settings')).toHaveLength(0);
  });

  it('oversized content and oversized on-disk reads → FileTooLargeError', async () => {
    const small = new HarnessFileEngine({
      backupsDir: path.join(tmp, 'backups'),
      jailRoots: [home],
      maxBytes: 16,
    });
    await expect(
      small.write('claude.md.global', path.join(home, 'CLAUDE.md'), {
        expectedSha: null,
        content: 'x'.repeat(17),
        format: 'markdown',
      }),
    ).rejects.toBeInstanceOf(FileTooLargeError);
    fs.writeFileSync(path.join(home, 'CLAUDE.md'), 'y'.repeat(32));
    await expect(
      small.read('claude.md.global', path.join(home, 'CLAUDE.md')),
    ).rejects.toBeInstanceOf(FileTooLargeError);
  });

  it('jail: out-of-root paths and bad fileIds refuse before any fs mutation', async () => {
    await expect(
      engine.write('claude.settings', path.join(tmp, 'outside.json'), {
        expectedSha: null,
        content: '{}',
        format: 'json',
      }),
    ).rejects.toBeInstanceOf(PathJailError);
    await expect(
      engine.write('../evil', target(), { expectedSha: null, content: '{}', format: 'json' }),
    ).rejects.toBeInstanceOf(PathJailError);
    expect(fs.existsSync(path.join(tmp, 'outside.json'))).toBe(false);
  });

  it('refuses a symlinked final path (write-through-symlink escape)', async () => {
    const outside = path.join(tmp, 'real-target.json');
    fs.writeFileSync(outside, '{}');
    fs.mkdirSync(path.dirname(target()), { recursive: true });
    fs.symlinkSync(outside, target());
    await expect(
      engine.write('claude.settings', target(), {
        expectedSha: contentSha('{}'),
        content: '{"pwned":true}',
        format: 'json',
      }),
    ).rejects.toBeInstanceOf(PathJailError);
    expect(fs.readFileSync(outside, 'utf8')).toBe('{}');
  });

  it('preserves an existing file mode across the atomic rename', async () => {
    fs.mkdirSync(path.dirname(target()), { recursive: true });
    fs.writeFileSync(target(), '{"m":1}', { mode: 0o644 });
    await engine.write('claude.settings', target(), {
      expectedSha: contentSha('{"m":1}'),
      content: '{"m":2}',
      format: 'json',
    });
    expect(fs.statSync(target()).mode & 0o777).toBe(0o644);
  });
});

describe('backups: rotation + restore', () => {
  it('the 21st backup rotates the oldest out (20 kept)', async () => {
    let sha: string | null = null;
    // 22 writes = 21 backups taken (first write backs up nothing).
    for (let i = 0; i < 22; i++) {
      const content = `{"i":${i}}`;
      const facts = await engine.write('claude.settings', target(), {
        expectedSha: sha,
        content,
        format: 'json',
      });
      sha = facts.sha;
      // Backup names are ms-timestamped; keep writes in distinct ticks.
      await new Promise((r) => setTimeout(r, 2));
    }
    const backups = await engine.listBackups('claude.settings');
    expect(backups).toHaveLength(20);
    // Newest first; the oldest surviving backup is i=1 (i=0 rotated out).
    expect(backups[0]?.sha).toBe(contentSha('{"i":20}'));
    expect(backups.some((b) => b.sha === contentSha('{"i":0}'))).toBe(false);
    expect(backups.at(-1)?.sha).toBe(contentSha('{"i":1}'));
  });

  it('restore round trip is byte-identical and itself undoable', async () => {
    const contentA = '{"gen":"A","값":1}\n';
    const contentB = '{"gen":"B"}\n';
    const a = await engine.write('claude.settings', target(), {
      expectedSha: null,
      content: contentA,
      format: 'json',
    });
    await engine.write('claude.settings', target(), {
      expectedSha: a.sha,
      content: contentB,
      format: 'json',
    });
    const backups = await engine.listBackups('claude.settings');
    const backupOfA = backups.find((b) => b.sha === contentSha(contentA))!;
    expect(backupOfA).toBeTruthy();

    const restored = await engine.restore('claude.settings', target(), {
      backupId: backupOfA.backupId,
      expectedSha: contentSha(contentB),
      format: 'json',
    });
    expect(restored.sha).toBe(contentSha(contentA));
    expect(fs.readFileSync(target()).equals(Buffer.from(contentA, 'utf8'))).toBe(true);
    // The restore backed up B first → the round trip is undoable.
    const after = await engine.listBackups('claude.settings');
    expect(after.some((b) => b.sha === contentSha(contentB))).toBe(true);
  });

  it('unknown or tampered backups are backup_not_found, never restored', async () => {
    const a = await engine.write('claude.settings', target(), {
      expectedSha: null,
      content: '{"v":1}',
      format: 'json',
    });
    await engine.write('claude.settings', target(), {
      expectedSha: a.sha,
      content: '{"v":2}',
      format: 'json',
    });
    await expect(
      engine.restore('claude.settings', target(), {
        backupId: '1700000000000-000000000000.bak',
        expectedSha: contentSha('{"v":2}'),
        format: 'json',
      }),
    ).rejects.toBeInstanceOf(BackupNotFoundError);
    // Tamper with the real backup's bytes: sha prefix no longer matches.
    const [entry] = await engine.listBackups('claude.settings');
    const backupPath = path.join(tmp, 'backups', 'claude.settings', entry!.backupId);
    fs.writeFileSync(backupPath, '{"tampered":true}');
    await expect(
      engine.restore('claude.settings', target(), {
        backupId: entry!.backupId,
        expectedSha: contentSha('{"v":2}'),
        format: 'json',
      }),
    ).rejects.toBeInstanceOf(BackupNotFoundError);
    expect(await engine.listBackups('claude.settings')).toHaveLength(0); // omitted as tampered
    expect(fs.readFileSync(target(), 'utf8')).toBe('{"v":2}');
    // Path-shaped backupIds never reach the filesystem.
    await expect(
      engine.restore('claude.settings', target(), {
        backupId: '../../escape.bak',
        expectedSha: contentSha('{"v":2}'),
        format: 'json',
      }),
    ).rejects.toBeInstanceOf(BackupNotFoundError);
  });

  it('read reports honest nulls for an absent file', async () => {
    const state = await engine.read('claude.settings', target());
    expect(state).toEqual({ exists: false, content: null, sha: null, size: null, mtime: null });
  });
});
