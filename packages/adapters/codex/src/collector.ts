/**
 * Codex CLI session collector — ports control-tower's
 * `server/collectors/codex.js` into the SDK {@link SessionCollector} contract,
 * then enriches from the Codex state DB.
 *
 * Discovery:
 *  1. `<codexHome>/session_index.jsonl` maps `id → {thread_name, updated_at}`
 *     (append-ordered; later lines win).
 *  2. `<codexHome>/sessions/YYYY/MM/DD/rollout-<iso>-<uuid>.jsonl` are the
 *     transcripts. A session can own several rollouts (resume) — the newest
 *     mtime wins. The first line (`session_meta`) yields cwd + originator.
 *  3. Liveness is APPROXIMATE: Codex exposes no live-session API, so a rollout
 *     touched within {@link LIVE_WINDOW_MS} is treated as live. Every detailed
 *     session carries `liveConfidence: 'approx'` so the panel never renders this
 *     heuristic as a hard fact.
 *  4. When `<codexHome>/state_*.sqlite` is readable, its `threads` table enriches
 *     cwd / model / branch / approval_mode. A missing/locked DB simply skips
 *     enrichment (honest degrade, never a throw).
 *
 * `collect()` returns SCHEMA-STRICT {@link DiscoveredSession}s (the conformance
 * runner validates them with a strict schema). The Codex-rich fields live on
 * {@link CodexSessionDetail} returned by {@link CodexSessionCollector.collectDetailed}.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type {
  CollectContext,
  DiscoveredSession,
  SessionCollector,
  TranscriptRef,
} from '@terminull/adapter-sdk';

const LIVE_WINDOW_MS = 5 * 60 * 1000;
const RECENT_LIMIT = 40;
const HEAD_WINDOW = 8192;

/** rollout filename → session id (uuid suffix after the timestamp). */
const SID_RE = /rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

/** Per-session enrichment read from the Codex state DB `threads` table. */
export interface ThreadEnrichment {
  cwd?: string;
  model?: string;
  branch?: string;
  approvalMode?: string;
  title?: string;
}

/** A discovered session plus Codex-specific enrichment + liveness confidence. */
export interface CodexSessionDetail extends DiscoveredSession {
  /** Always `'approx'`: liveness is an mtime heuristic, never a verified fact. */
  liveConfidence: 'approx';
  model?: string;
  branch?: string;
  approvalMode?: string;
  originator?: string;
}

/** A {@link SessionCollector} that also exposes Codex-rich session details. */
export interface CodexSessionCollector extends SessionCollector {
  collectDetailed(ctx: CollectContext): Promise<CodexSessionDetail[]>;
}

/** Options for {@link createCodexCollector}. */
export interface CodexCollectorOptions {
  /** Override the `.codex` home (defaults to `<ctx.home ?? homedir>/.codex`). */
  codexHome?: string;
  /** Override the state DB path (defaults to a `state_*.sqlite` scan in the home). */
  statePath?: string;
}

async function readHead(file: string, bytes = HEAD_WINDOW): Promise<string> {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.toString('utf8', 0, bytesRead);
  } finally {
    await fh.close();
  }
}

interface IndexEntry {
  thread_name?: string;
  updated_at?: string;
}

async function loadIndex(indexPath: string): Promise<Map<string, IndexEntry>> {
  const map = new Map<string, IndexEntry>();
  let raw: string;
  try {
    raw = await fsp.readFile(indexPath, 'utf8');
  } catch {
    return map; // no index yet
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line) as { id?: string } & IndexEntry;
      if (j.id) map.set(j.id, j); // later lines win — file is append-ordered
    } catch {
      /* skip torn line */
    }
  }
  return map;
}

/** One rollout file discovered under `sessions/YYYY/MM/DD`. */
export interface RolloutHit {
  file: string;
  sid: string;
  mtime: number;
}

/** Enumerate every `rollout-*.jsonl` under a `sessions/` dir (≤3 levels deep). */
export async function listRollouts(sessionsDir: string): Promise<RolloutHit[]> {
  const out: RolloutHit[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) {
        await walk(full, depth + 1);
      } else if (e.isFile()) {
        const m = SID_RE.exec(e.name);
        if (!m || !m[1]) continue;
        try {
          const st = await fsp.stat(full);
          out.push({ file: full, sid: m[1], mtime: st.mtimeMs });
        } catch {
          /* raced deletion */
        }
      }
    }
  };
  await walk(sessionsDir, 0);
  return out;
}

/**
 * Read `threads` rows keyed by id from the Codex state DB, READ-ONLY. Uses the
 * built-in `node:sqlite` module; a runtime without it (or a locked/missing DB)
 * yields an empty map so enrichment simply does not happen.
 */
async function loadThreads(
  codexHome: string,
  statePath: string | undefined,
): Promise<Map<string, ThreadEnrichment>> {
  const out = new Map<string, ThreadEnrichment>();
  const candidates = statePath
    ? [statePath]
    : (() => {
        try {
          return fs
            .readdirSync(codexHome)
            .filter((f) => /^state_\d+\.sqlite$/.test(f))
            .map((f) => path.join(codexHome, f))
            .sort()
            .reverse();
        } catch {
          return [];
        }
      })();
  if (candidates.length === 0) return out;

  // Load the `node:sqlite` builtin via createRequire with a VARIABLE specifier:
  // a static `import 'node:sqlite'` is rewritten by bundlers that do not yet know
  // this new builtin (they strip the `node:` prefix and fail to resolve). A
  // runtime require of a variable specifier is opaque to that rewrite and hits
  // the real Node builtin; a runtime without it simply throws → no enrichment.
  let DatabaseSync: (new (p: string, o?: { readOnly?: boolean }) => SqliteDb) | undefined;
  try {
    const sqliteSpecifier = 'node:sqlite';
    const req = createRequire(import.meta.url);
    ({ DatabaseSync } = req(sqliteSpecifier) as {
      DatabaseSync: new (p: string, o?: { readOnly?: boolean }) => SqliteDb;
    });
  } catch {
    return out; // node:sqlite unavailable → no enrichment
  }

  for (const dbPath of candidates) {
    if (!fs.existsSync(dbPath)) continue;
    let db: SqliteDb | undefined;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const cols = (db.prepare('PRAGMA table_info(threads)').all() as { name?: string }[])
        .map((c) => c.name)
        .filter((n): n is string => typeof n === 'string');
      if (!cols.includes('id')) continue;
      const want: Record<string, keyof ThreadEnrichment> = {
        cwd: 'cwd',
        model: 'model',
        git_branch: 'branch',
        approval_mode: 'approvalMode',
        title: 'title',
      };
      const select = ['id', ...Object.keys(want).filter((c) => cols.includes(c))];
      const rows = db.prepare(`SELECT ${select.join(', ')} FROM threads`).all() as Record<
        string,
        unknown
      >[];
      for (const row of rows) {
        const id = typeof row['id'] === 'string' ? (row['id'] as string) : undefined;
        if (!id) continue;
        const enr: ThreadEnrichment = {};
        for (const [col, key] of Object.entries(want)) {
          const v = row[col];
          if (typeof v === 'string' && v.length > 0) enr[key] = v;
        }
        out.set(id, enr);
      }
      return out; // first DB with a usable threads table wins
    } catch {
      /* unreadable/locked DB → try the next candidate */
    } finally {
      try {
        db?.close();
      } catch {
        /* already closed */
      }
    }
  }
  return out;
}

/** Minimal structural view of the `node:sqlite` DatabaseSync API we rely on. */
interface SqliteDb {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  close(): void;
}

/**
 * Create a Codex CLI session collector. `collectDetailed` returns the Codex-rich
 * view; `collect` narrows it to the schema-strict SDK shape.
 */
export function createCodexCollector(opts: CodexCollectorOptions = {}): CodexSessionCollector {
  const homeOf = (ctx: CollectContext): string =>
    opts.codexHome ?? path.join(ctx.home ?? os.homedir(), '.codex');

  async function collectDetailed(ctx: CollectContext): Promise<CodexSessionDetail[]> {
    const codexHome = homeOf(ctx);
    const sessionsDir = path.join(codexHome, 'sessions');
    const indexPath = path.join(codexHome, 'session_index.jsonl');
    const now = ctx.now ?? Date.now();

    const [index, rollouts, threads] = await Promise.all([
      loadIndex(indexPath),
      listRollouts(sessionsDir),
      loadThreads(codexHome, opts.statePath),
    ]);

    // A session can have several rollout files (resume) — keep the newest.
    const bySid = new Map<string, RolloutHit>();
    for (const r of rollouts) {
      const prev = bySid.get(r.sid);
      if (!prev || r.mtime > prev.mtime) bySid.set(r.sid, r);
    }
    const picked = [...bySid.values()].sort((a, b) => b.mtime - a.mtime).slice(0, RECENT_LIMIT);

    return Promise.all(
      picked.map(async (r): Promise<CodexSessionDetail> => {
        let metaCwd: string | undefined;
        let originator: string | undefined;
        try {
          const head = await readHead(r.file);
          const nl = head.indexOf('\n');
          const first = JSON.parse(nl === -1 ? head : head.slice(0, nl)) as {
            payload?: { cwd?: unknown; originator?: unknown };
          };
          const pc = first.payload?.cwd;
          const po = first.payload?.originator;
          if (typeof pc === 'string') metaCwd = pc;
          if (typeof po === 'string') originator = po;
        } catch {
          /* first line may exceed the head window — keep undefined */
        }
        const enr = threads.get(r.sid) ?? {};
        const idx = index.get(r.sid) ?? {};
        const live = now - r.mtime < LIVE_WINDOW_MS;
        const cwd = enr.cwd ?? metaCwd;
        const title = idx.thread_name || enr.title;
        const transcriptRef: TranscriptRef = { kind: 'file', path: r.file };
        return {
          id: r.sid,
          tool: 'codex',
          live,
          liveConfidence: 'approx',
          updatedAt: r.mtime,
          transcriptRef,
          ...(cwd ? { cwd } : {}),
          ...(title ? { title } : {}),
          ...(enr.model ? { model: enr.model } : {}),
          ...(enr.branch ? { branch: enr.branch } : {}),
          ...(enr.approvalMode ? { approvalMode: enr.approvalMode } : {}),
          ...(originator ? { originator } : {}),
        };
      }),
    );
  }

  return {
    async collect(ctx: CollectContext): Promise<DiscoveredSession[]> {
      const detailed = await collectDetailed(ctx);
      // Narrow to the schema-strict SDK shape (drop Codex-rich extras).
      return detailed.map((d) => ({
        id: d.id,
        tool: d.tool,
        live: d.live,
        ...(d.cwd ? { cwd: d.cwd } : {}),
        ...(d.title ? { title: d.title } : {}),
        ...(d.updatedAt !== undefined ? { updatedAt: d.updatedAt } : {}),
        ...(d.transcriptRef ? { transcriptRef: d.transcriptRef } : {}),
      }));
    },
    collectDetailed,
    watchPaths(ctx: CollectContext): string[] {
      const codexHome = homeOf(ctx);
      return [path.join(codexHome, 'sessions'), path.join(codexHome, 'session_index.jsonl')];
    },
  };
}
