/**
 * Harness-editor store tests (M9 W2 / oracle b, UI half). The save flow under
 * test: the PUT carries the LAST-READ sha as `expectedSha` (null for absent
 * files), a 409 becomes a conflict outcome carrying the server's currentSha
 * with the DRAFT untouched, a 422 surfaces the parser detail VERBATIM with
 * the draft untouched, a success reports its real validation depth, and a
 * restore re-reads the file (fresh lock) before reporting. All fetches
 * mocked; no real home directories anywhere.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { HarnessReadDto } from '@terminull/shared';
import { setFetchImpl } from '../api/client';
import { useHarnessStore } from './harness';

let restoreFetch: (() => void) | null = null;

afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
  useHarnessStore.setState({
    groups: [],
    loaded: false,
    errorCode: null,
    custom: null,
    customErrorCode: null,
    files: {},
  });
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function readDto(overrides: Partial<HarnessReadDto> = {}): HarnessReadDto {
  return {
    fileId: 'claude.settings',
    toolId: 'claude',
    path: '/fake/home/.claude/settings.json',
    exists: true,
    content: '{"hooks":{}}',
    sha: SHA_A,
    size: 12,
    mtime: 1000,
    ...overrides,
  };
}

async function openWith(read: HarnessReadDto): Promise<void> {
  restoreFetch?.();
  restoreFetch = setFetchImpl(() => Promise.resolve(json(200, read)));
  await useHarnessStore.getState().open(read.fileId);
  restoreFetch();
  restoreFetch = null;
}

describe('save flow', () => {
  it('PUTs the last-read sha as expectedSha and reports the real validation', async () => {
    await openWith(readDto());
    useHarnessStore.getState().setDraft('claude.settings', '{"hooks":{"Stop":[]}}');
    const puts: Array<[string, unknown]> = [];
    restoreFetch = setFetchImpl((url, init) => {
      puts.push([url, JSON.parse(String(init?.body))]);
      return Promise.resolve(
        json(200, {
          written: true,
          fileId: 'claude.settings',
          sha: SHA_B,
          backupId: '1000-aaaaaaaaaaaa.bak',
          validation: 'full',
        }),
      );
    });
    await useHarnessStore.getState().save('claude.settings');
    expect(puts).toEqual([
      [
        '/api/harness/files/claude.settings',
        { expectedSha: SHA_A, content: '{"hooks":{"Stop":[]}}' },
      ],
    ]);
    const entry = useHarnessStore.getState().files['claude.settings']!;
    expect(entry.outcome).toEqual({ kind: 'saved', validation: 'full', sha: SHA_B });
    // The read state now carries the new sha — the next save locks on it.
    expect(entry.read?.sha).toBe(SHA_B);
  });

  it('an absent file saves with expectedSha null (create-only lock)', async () => {
    await openWith(readDto({ exists: false, content: null, sha: null, size: null, mtime: null }));
    useHarnessStore.getState().setDraft('claude.settings', '# new');
    const bodies: unknown[] = [];
    restoreFetch = setFetchImpl((_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Promise.resolve(
        json(200, {
          written: true,
          fileId: 'claude.settings',
          sha: SHA_B,
          backupId: null,
          validation: 'none',
        }),
      );
    });
    await useHarnessStore.getState().save('claude.settings');
    expect(bodies).toEqual([{ expectedSha: null, content: '# new' }]);
  });

  it('409 → conflict outcome with the server currentSha; the draft survives', async () => {
    await openWith(readDto());
    useHarnessStore.getState().setDraft('claude.settings', '{"mine":1}');
    restoreFetch = setFetchImpl(() =>
      Promise.resolve(json(409, { code: 'sha_mismatch', currentSha: SHA_B })),
    );
    await useHarnessStore.getState().save('claude.settings');
    const entry = useHarnessStore.getState().files['claude.settings']!;
    expect(entry.outcome).toEqual({ kind: 'conflict', currentSha: SHA_B });
    expect(entry.draft).toBe('{"mine":1}');
    expect(entry.read?.sha).toBe(SHA_A); // untouched until an explicit reload
  });

  it('422 → the parser message VERBATIM (detail + line); the draft survives', async () => {
    await openWith(readDto());
    useHarnessStore.getState().setDraft('claude.settings', '{"hooks": {');
    restoreFetch = setFetchImpl(() =>
      Promise.resolve(
        json(422, {
          code: 'parse_invalid',
          format: 'json',
          detail: "Expected '}' but found end of input at position 11",
          line: 1,
        }),
      ),
    );
    await useHarnessStore.getState().save('claude.settings');
    const entry = useHarnessStore.getState().files['claude.settings']!;
    expect(entry.outcome).toEqual({
      kind: 'parse_invalid',
      format: 'json',
      detail: "Expected '}' but found end of input at position 11",
      line: 1,
    });
    expect(entry.draft).toBe('{"hooks": {');
  });
});

describe('restore flow', () => {
  it('restore re-reads the file (fresh lock) and refreshes backups, then reports', async () => {
    await openWith(readDto());
    const calls: string[] = [];
    restoreFetch = setFetchImpl((url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/restore')) {
        return Promise.resolve(
          json(200, {
            written: true,
            fileId: 'claude.settings',
            sha: SHA_B,
            backupId: '2000-bbbbbbbbbbbb.bak',
            validation: 'full',
          }),
        );
      }
      if (url.endsWith('/backups')) return Promise.resolve(json(200, { backups: [] }));
      return Promise.resolve(json(200, readDto({ sha: SHA_B, content: '{"restored":1}' })));
    });
    await useHarnessStore.getState().restore('claude.settings', '1000-aaaaaaaaaaaa.bak');
    expect(calls).toEqual([
      'POST /api/harness/files/claude.settings/restore',
      'GET /api/harness/files/claude.settings',
      'GET /api/harness/files/claude.settings/backups',
    ]);
    const entry = useHarnessStore.getState().files['claude.settings']!;
    expect(entry.read?.sha).toBe(SHA_B);
    expect(entry.outcome).toEqual({ kind: 'saved', validation: 'full', sha: SHA_B });
  });

  it('a restore against a vanished backup is an honest error code', async () => {
    await openWith(readDto());
    restoreFetch = setFetchImpl(() => Promise.resolve(json(404, { code: 'backup_not_found' })));
    await useHarnessStore.getState().restore('claude.settings', 'gone.bak');
    expect(useHarnessStore.getState().files['claude.settings']!.outcome).toEqual({
      kind: 'error',
      code: 'backup_not_found',
    });
  });
});

describe('manifest + custom', () => {
  it('loadManifest/loadCustom store the wire payloads; failures keep codes', async () => {
    const group = {
      toolId: 'claude',
      displayName: { en: 'Claude Code', ko: '클로드 코드' },
      files: [],
    };
    const custom = { id: 'custom' as const, scannedAt: 123, items: [], truncated: false };
    restoreFetch = setFetchImpl((url) =>
      Promise.resolve(url.endsWith('/custom') ? json(200, custom) : json(200, { groups: [group] })),
    );
    await useHarnessStore.getState().loadManifest();
    await useHarnessStore.getState().loadCustom();
    expect(useHarnessStore.getState().groups).toEqual([group]);
    expect(useHarnessStore.getState().custom).toEqual(custom);

    restoreFetch();
    restoreFetch = setFetchImpl(() => Promise.resolve(json(500, { code: 'internal' })));
    await useHarnessStore.getState().loadCustom();
    expect(useHarnessStore.getState().customErrorCode).toBe('internal');
    // A broken scan never erases the last good manifest state.
    expect(useHarnessStore.getState().groups).toEqual([group]);
  });
});
