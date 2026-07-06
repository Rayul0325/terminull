/**
 * M9 GATE ORACLE (a)(b)(c) — the harness file editor over HTTP against a FAKE
 * home (`collectHome` = a mkdtemp under the stack's tmp state dir). The real
 * ~/.claude is never touched: every response path is asserted to live under
 * the fake home.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { contentSha } from '@terminull/core';
import { api, startStack, type Stack } from './harness';

let stack: Stack;

afterEach(async () => {
  await stack.close();
});

const globalMd = (s: Stack): string => path.join(s.collectHome, '.claude', 'CLAUDE.md');
const settingsPath = (s: Stack): string => path.join(s.collectHome, '.claude', 'settings.json');

async function events(s: Stack): Promise<{ type: string; actor: string; payload: any }[]> {
  const res = await api(s, 'GET', '/api/events?since=0', { user: true });
  expect(res.status).toBe(200);
  return res.body.events;
}

describe('GET /api/harness/files (manifest)', () => {
  it('lists per-tool groups; directory specs are flagged; paths live in the fake home', async () => {
    stack = await startStack();
    const res = await api(stack, 'GET', '/api/harness/files', { user: true });
    expect(res.status).toBe(200);
    const groups = res.body.groups as { toolId: string; files: any[] }[];
    const claude = groups.find((g) => g.toolId === 'claude')!;
    expect(claude).toBeTruthy();
    const global = claude.files.find((f) => f.id === 'claude.md.global');
    expect(global.path).toBe(globalMd(stack));
    expect(global.exists).toBe(false);
    expect(global.riskLevel).toBe('low');
    const skills = claude.files.find((f) => f.id === 'claude.skills');
    expect(skills.directory).toBe(true);
    const codex = groups.find((g) => g.toolId === 'codex')!;
    expect(codex.files.some((f) => f.id === 'codex.config' && f.riskLevel === 'high')).toBe(true);
  });

  it('unknown file → 404 unknown_file; directory spec GET/PUT → 422 directory_not_editable', async () => {
    stack = await startStack();
    const missing = await api(stack, 'GET', '/api/harness/files/no.such.file', { user: true });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('unknown_file');
    const dirGet = await api(stack, 'GET', '/api/harness/files/claude.skills', { user: true });
    expect(dirGet.status).toBe(422);
    expect(dirGet.body.code).toBe('directory_not_editable');
    const dirPut = await api(stack, 'PUT', '/api/harness/files/claude.skills', {
      user: true,
      body: { expectedSha: null, content: 'x' },
    });
    expect(dirPut.status).toBe(422);
    expect(dirPut.body.code).toBe('directory_not_editable');
  });

  it('an on-disk file over the cap refuses reads with 413 file_too_large', async () => {
    stack = await startStack();
    fs.mkdirSync(path.dirname(globalMd(stack)), { recursive: true });
    fs.writeFileSync(globalMd(stack), 'y'.repeat(1024 * 1024 + 1));
    const res = await api(stack, 'GET', '/api/harness/files/claude.md.global', { user: true });
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('file_too_large');
  });
});

describe('GATE oracle (a) — fake-home write round trip', () => {
  it('read nulls → create → update+backup → stale 409 → restore byte-identical → rotation', async () => {
    stack = await startStack();
    const base = '/api/harness/files/claude.md.global';

    // Absent file reads as honest nulls.
    const empty = await api(stack, 'GET', base, { user: true });
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({ exists: false, content: null, sha: null, size: null });
    expect(empty.body.path).toBe(globalMd(stack));
    expect(empty.body.path.startsWith(stack.collectHome)).toBe(true); // never the real home

    // Create (expectedSha null).
    const contentA = '# 지침 A\nalpha\n';
    const putA = await api(stack, 'PUT', base, {
      user: true,
      body: { expectedSha: null, content: contentA },
    });
    expect(putA.status).toBe(200);
    expect(putA.body).toMatchObject({
      written: true,
      fileId: 'claude.md.global',
      sha: contentSha(contentA),
      backupId: null,
      validation: 'none',
    });
    expect(fs.readFileSync(globalMd(stack), 'utf8')).toBe(contentA);

    // Update — the previous content gets a backup.
    const contentB = '# 지침 B\nbeta\n';
    const putB = await api(stack, 'PUT', base, {
      user: true,
      body: { expectedSha: contentSha(contentA), content: contentB },
    });
    expect(putB.status).toBe(200);
    expect(putB.body.backupId).toMatch(/^\d+-[0-9a-f]{12}\.bak$/);

    // STALE expectedSha → 409 sha_mismatch carrying the CURRENT sha.
    const stale = await api(stack, 'PUT', base, {
      user: true,
      body: { expectedSha: contentSha(contentA), content: 'stale write' },
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'sha_mismatch', currentSha: contentSha(contentB) });
    expect(fs.readFileSync(globalMd(stack), 'utf8')).toBe(contentB); // untouched

    // Backups list has A's backup; restore is byte-identical to A.
    const backups = await api(stack, 'GET', `${base}/backups`, { user: true });
    expect(backups.status).toBe(200);
    const backupOfA = backups.body.backups.find((b: any) => b.sha === contentSha(contentA));
    expect(backupOfA).toBeTruthy();
    const restore = await api(stack, 'POST', `${base}/restore`, {
      user: true,
      body: { backupId: backupOfA.backupId, expectedSha: contentSha(contentB) },
    });
    expect(restore.status).toBe(200);
    expect(restore.body.sha).toBe(contentSha(contentA));
    const readBack = await api(stack, 'GET', base, { user: true });
    expect(readBack.body.content).toBe(contentA);
    expect(readBack.body.sha).toBe(contentSha(contentA));

    // Unknown backup id → 404 backup_not_found.
    const missing = await api(stack, 'POST', `${base}/restore`, {
      user: true,
      body: { backupId: '1700000000000-000000000000.bak', expectedSha: contentSha(contentA) },
    });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('backup_not_found');

    // Rotation: hammer writes until 21+ backups were taken → 20 remain and the
    // OLDEST (contentA from the restore step) rotated out.
    let sha = contentSha(contentA);
    for (let i = 0; i < 24; i++) {
      const content = `# rotation ${i}\n`;
      const res = await api(stack, 'PUT', base, {
        user: true,
        body: { expectedSha: sha, content },
      });
      expect(res.status).toBe(200);
      sha = res.body.sha;
      await new Promise((r) => setTimeout(r, 2)); // distinct ms-named backups
    }
    const rotated = await api(stack, 'GET', `${base}/backups`, { user: true });
    expect(rotated.body.backups).toHaveLength(20);
    expect(rotated.body.backups.some((b: any) => b.sha === contentSha(contentA))).toBe(false);

    // The audit trail carries shas/sizes ONLY — no content, no diff.
    const written = (await events(stack)).filter((e) => e.type === 'harness.file_written');
    expect(written.length).toBeGreaterThanOrEqual(26);
    for (const e of written) {
      expect(e.payload.fileId).toBe('claude.md.global');
      expect(e.payload.sha).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(e.payload)).not.toContain('alpha');
      expect(JSON.stringify(e.payload)).not.toContain('rotation');
      expect(e.payload.content).toBeUndefined();
      expect(e.payload.diff).toBeUndefined();
    }
    const restored = (await events(stack)).filter((e) => e.type === 'harness.file_restored');
    expect(restored).toHaveLength(1);
    expect(restored[0]!.payload.restoredFrom).toBe(backupOfA.backupId);
  }, 30_000);
});

describe('GATE oracle (b) — corrupted settings.json', () => {
  it('PUT with broken JSON → 422 parse_invalid; disk unchanged; no backup consumed', async () => {
    stack = await startStack();
    const base = '/api/harness/files/claude.settings';
    const valid = '{"model": "sonnet"}\n';
    const create = await api(stack, 'PUT', base, {
      user: true,
      body: { expectedSha: null, content: valid },
    });
    expect(create.status).toBe(200);
    expect(create.body.validation).toBe('full');
    const shaBefore = contentSha(fs.readFileSync(settingsPath(stack)));

    const res = await api(stack, 'PUT', base, {
      user: true,
      body: { expectedSha: contentSha(valid), content: '{"hooks": {' },
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('parse_invalid');
    expect(res.body.format).toBe('json');
    expect(res.body.detail).toMatch(/JSON/i); // the parser's own message, verbatim

    const shaAfter = contentSha(fs.readFileSync(settingsPath(stack)));
    expect(shaAfter).toBe(shaBefore);
    const backups = await api(stack, 'GET', `${base}/backups`, { user: true });
    expect(backups.body.backups).toHaveLength(0); // no backup consumed
  });
});

describe('toml validation honesty', () => {
  it('codex.config writes report validation:lint (never full) and lint-refuse broken toml', async () => {
    stack = await startStack();
    const ok = await api(stack, 'PUT', '/api/harness/files/codex.config', {
      user: true,
      body: { expectedSha: null, content: 'model = "o3"\n[mcp_servers.kordis]\ncommand = "x"\n' },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.validation).toBe('lint'); // structural lint, honestly not 'full'
    const bad = await api(stack, 'PUT', '/api/harness/files/codex.config', {
      user: true,
      body: { expectedSha: ok.body.sha, content: 'just words, not toml' },
    });
    expect(bad.status).toBe(422);
    expect(bad.body).toMatchObject({ code: 'parse_invalid', format: 'toml', line: 1 });
  });
});

describe('GATE oracle (c) — danger-file agent writes park in the confirm queue', () => {
  it('agent PUT on riskLevel-high parks (floor beats autonomous); approval writes it', async () => {
    // Permissions WIDENED to autonomous on purpose: the immutable core floor
    // must still force confirm for danger files.
    stack = await startStack({
      permissions: { 'harness.write_danger': 'autonomous', 'harness.write': 'autonomous' },
    });
    const base = '/api/harness/files/claude.settings';
    const contentA = '{"gen":"A"}\n';
    const contentB = '{"gen":"B"}\n';
    const create = await api(stack, 'PUT', base, {
      user: true,
      body: { expectedSha: null, content: contentA },
    });
    expect(create.status).toBe(200);

    const put = await api(stack, 'PUT', base, {
      actor: 'agent',
      body: { expectedSha: contentSha(contentA), content: contentB },
    });
    expect(put.status).toBe(202);
    expect(put.body.code).toBe('pending_confirmation');
    expect(put.body.action).toBe('harness.write_danger');
    // File UNCHANGED until the user approves.
    expect(fs.readFileSync(settingsPath(stack), 'utf8')).toBe(contentA);

    const approve = await api(
      stack,
      'POST',
      `/api/confirmations/${put.body.confirmationId}/approve`,
      { user: true, body: {} },
    );
    expect(approve.status).toBe(200);
    expect(approve.body.resultStatus).toBe(200);
    expect(approve.body.result.written).toBe(true);
    expect(fs.readFileSync(settingsPath(stack), 'utf8')).toBe(contentB);

    const written = (await events(stack)).filter((e) => e.type === 'harness.file_written');
    expect(written.at(-1)).toMatchObject({
      actor: 'agent',
      payload: { fileId: 'claude.settings', sha: contentSha(contentB) },
    });
  });

  it('low-risk file under harness.write:autonomous → agent writes directly (floor only guards danger)', async () => {
    stack = await startStack({ permissions: { 'harness.write': 'autonomous' } });
    const res = await api(stack, 'PUT', '/api/harness/files/claude.md.global', {
      actor: 'agent',
      body: { expectedSha: null, content: '# agent-authored\n' },
    });
    expect(res.status).toBe(200);
    expect(res.body.written).toBe(true);
    expect(fs.readFileSync(globalMd(stack), 'utf8')).toBe('# agent-authored\n');
  });

  it('agent PUT with parse-invalid content 422s BEFORE parking a confirmation', async () => {
    stack = await startStack();
    const res = await api(stack, 'PUT', '/api/harness/files/claude.settings', {
      actor: 'agent',
      body: { expectedSha: null, content: '{"broken":' },
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('parse_invalid');
    const pending = await api(stack, 'GET', '/api/confirmations', { user: true });
    expect(pending.body.pending).toHaveLength(0); // never parked
  });
});
