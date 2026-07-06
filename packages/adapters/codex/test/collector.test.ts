import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCodexCollector } from '../src/collector';

// Variable specifier so Vite does not rewrite the (new) `node:sqlite` builtin.
// `node:sqlite` is unavailable on Node < 22.5 and is flag-gated on 22.5–23.3,
// where a bare require throws. Load it lazily and guarded so this whole file
// (incl. the no-DB honest-degrade test) still runs on those runtimes — the
// enrichment test itself is skipped there, mirroring the collector's own
// runtime degrade path.
const sqliteSpecifier = 'node:sqlite';
let DatabaseSync:
  | (new (p: string) => {
      exec(sql: string): void;
      prepare(sql: string): { run(...args: unknown[]): unknown };
      close(): void;
    })
  | undefined;
try {
  ({ DatabaseSync } = createRequire(import.meta.url)(sqliteSpecifier));
} catch {
  DatabaseSync = undefined;
}
const hasSqlite = DatabaseSync !== undefined;

let home: string;
let codexHome: string;

const SID_LIVE = '019f3385-697e-70b3-b728-f2c9c9d0bac5';
const SID_OLD = '019e4cdd-946d-7be3-8e61-35445d38ace0';

function writeRollout(
  dateParts: [string, string, string],
  iso: string,
  sid: string,
  meta: object,
): string {
  const dir = path.join(codexHome, 'sessions', ...dateParts);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-${iso}-${sid}.jsonl`);
  const line = JSON.stringify({ type: 'session_meta', payload: meta });
  fs.writeFileSync(file, line + '\n');
  return file;
}

function writeStateDb(): void {
  const db = new DatabaseSync!(path.join(codexHome, 'state_5.sqlite'));
  db.exec(
    'CREATE TABLE threads (id TEXT, cwd TEXT, model TEXT, git_branch TEXT, approval_mode TEXT, title TEXT)',
  );
  const ins = db.prepare(
    'INSERT INTO threads (id, cwd, model, git_branch, approval_mode, title) VALUES (?, ?, ?, ?, ?, ?)',
  );
  ins.run(SID_LIVE, '/db/cwd', 'gpt-5-codex', 'main', 'on-request', 'DB Title');
  db.close();
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-codex-col-'));
  codexHome = path.join(home, '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('createCodexCollector', () => {
  it.skipIf(!hasSqlite)('discovers rollouts, applies the mtime liveness heuristic, and enriches from the state DB', async () => {
    const now = Date.now();
    writeRollout(['2026', '07', '06'], '2026-07-06T00-00-00', SID_LIVE, {
      cwd: '/meta/cwd',
      originator: 'cli',
    });
    const oldFile = writeRollout(['2026', '07', '01'], '2026-07-01T00-00-00', SID_OLD, {
      cwd: '/old/cwd',
      originator: 'vscode',
    });
    // Age the old rollout 10 minutes into the past (outside the 5-min live window).
    const past = (now - 10 * 60 * 1000) / 1000;
    fs.utimesSync(oldFile, past, past);
    writeStateDb();

    // session_index provides a thread_name title for the live session.
    fs.writeFileSync(
      path.join(codexHome, 'session_index.jsonl'),
      JSON.stringify({ id: SID_LIVE, thread_name: 'Index Title', updated_at: '2026-07-06' }) + '\n',
    );

    const collector = createCodexCollector({ codexHome });
    const detailed = await collector.collectDetailed({ now });

    const live = detailed.find((s) => s.id === SID_LIVE);
    const old = detailed.find((s) => s.id === SID_OLD);

    expect(live?.live).toBe(true);
    expect(old?.live).toBe(false);

    // Liveness is never claimed as a hard fact.
    expect(live?.liveConfidence).toBe('approx');

    // DB cwd overrides the session_meta cwd; DB model/branch/approval surfaced.
    expect(live?.cwd).toBe('/db/cwd');
    expect(live?.model).toBe('gpt-5-codex');
    expect(live?.branch).toBe('main');
    expect(live?.approvalMode).toBe('on-request');
    // session_index thread_name wins as the title.
    expect(live?.title).toBe('Index Title');
    // originator from the rollout head.
    expect(live?.originator).toBe('cli');

    // The un-enriched old session keeps its session_meta cwd.
    expect(old?.cwd).toBe('/old/cwd');
    expect(old?.transcriptRef).toEqual({ kind: 'file', path: oldFile });
  });

  it('collect() returns the schema-strict shape (no Codex-rich extra keys)', async () => {
    writeRollout(['2026', '07', '06'], '2026-07-06T00-00-00', SID_LIVE, { cwd: '/meta/cwd' });
    const collector = createCodexCollector({ codexHome });
    const sessions = await collector.collect({});
    expect(sessions).toHaveLength(1);
    const s = sessions[0]!;
    expect(Object.keys(s).sort()).toEqual([
      'cwd',
      'id',
      'live',
      'tool',
      'transcriptRef',
      'updatedAt',
    ]);
    expect((s as Record<string, unknown>)['liveConfidence']).toBeUndefined();
    expect((s as Record<string, unknown>)['model']).toBeUndefined();
  });

  it('degrades honestly when the state DB is absent (no enrichment, no throw)', async () => {
    writeRollout(['2026', '07', '06'], '2026-07-06T00-00-00', SID_LIVE, { cwd: '/meta/cwd' });
    const collector = createCodexCollector({ codexHome });
    const detailed = await collector.collectDetailed({});
    expect(detailed[0]?.cwd).toBe('/meta/cwd'); // meta cwd, no DB override
    expect(detailed[0]?.model).toBeUndefined();
  });

  it('returns [] when the codex home does not exist', async () => {
    const collector = createCodexCollector({ codexHome: path.join(home, 'nope', '.codex') });
    expect(await collector.collect({})).toEqual([]);
  });

  it('exposes watchPaths for the sessions dir + session index', () => {
    const collector = createCodexCollector({ codexHome });
    expect(collector.watchPaths?.({})).toEqual([
      path.join(codexHome, 'sessions'),
      path.join(codexHome, 'session_index.jsonl'),
    ]);
  });
});
