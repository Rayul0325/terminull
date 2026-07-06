/**
 * Antigravity (`agy`) session collector.
 *
 * agy stores each conversation as a SQLite database at
 * `<geminiHome>/antigravity-cli/conversations/<id>.db` (with `-shm`/`-wal` WAL
 * sidecars). The row contents are OPAQUE protobuf BLOBs, so this collector
 * NEVER opens or parses a db — it only enumerates the files and reads their
 * mtimes. Concretely, per discovered session:
 *  - `id`         = the db filename without the `.db` suffix (the conversation id).
 *  - `updatedAt`  = the db file mtime (ms).
 *  - `live`       = an mtime HEURISTIC: true iff the db was touched within
 *    `liveWindowMs` of `now`. This is the honest ceiling of what agy exposes —
 *    there is no PID registry or runtime file — so it is deliberately coarse.
 *  - `cwd`        = recovered (best-effort) by inverting
 *    `<...>/cache/last_conversations.json`, a `{ <cwd>: <conversation-id> }` map.
 *  - `title`      = ALWAYS omitted: agy exposes no plaintext title (the only
 *    candidate source, last_conversations.json, holds ids not titles). Honest
 *    null beats a fabricated label.
 *  - `transcriptRef` = an `opaque` handle pointing at the db path; there is no
 *    parser (capability `transcript: 'opaque'`), so the UI shows terminal-only.
 *
 * `geminiHome` is configurable so tests point it at a fixture tree; it defaults
 * to `<ctx.home ?? os.homedir()>/.gemini`.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  CollectContext,
  DiscoveredSession,
  SessionCollector,
  TranscriptRef,
} from '@terminull/adapter-sdk';

/** Default liveness window: a conversation touched within this is "approx live". */
const DEFAULT_LIVE_WINDOW_MS = 120_000;
/** Safety cap on how many sessions are returned (most-recent first). */
const DEFAULT_LIMIT = 200;

/** Options for {@link createAgyCollector}. */
export interface AgyCollectorOptions {
  /** Override the `.gemini` home (defaults to `<ctx.home ?? homedir>/.gemini`). */
  geminiHome?: string;
  /** How recent (ms) a db mtime must be to count as approximately live. */
  liveWindowMs?: number;
  /** Max sessions returned (most-recent first). */
  limit?: number;
}

interface Paths {
  conversationsDir: string;
  lastConversationsFile: string;
}

function pathsOf(opts: AgyCollectorOptions, ctx: CollectContext): Paths {
  const geminiHome = opts.geminiHome ?? path.join(ctx.home ?? os.homedir(), '.gemini');
  const cliDir = path.join(geminiHome, 'antigravity-cli');
  return {
    conversationsDir: path.join(cliDir, 'conversations'),
    lastConversationsFile: path.join(cliDir, 'cache', 'last_conversations.json'),
  };
}

/**
 * Read `last_conversations.json` and invert it into a `conversationId -> cwd`
 * map. The file is `{ <cwd>: <conversation-id> }`; anything not a string→string
 * pair is ignored. Missing/unreadable/malformed → empty map (honest, no throw).
 */
async function readCwdByConversationId(file: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return out;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
  for (const [cwd, id] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof id === 'string' && id.length > 0 && cwd.length > 0 && !out.has(id)) {
      out.set(id, cwd);
    }
  }
  return out;
}

/**
 * Create an agy session collector. The returned {@link SessionCollector}
 * enumerates conversation dbs by mtime (most-recent first), approximating
 * liveness from the mtime window, and recovering cwd from the cache map.
 */
export function createAgyCollector(opts: AgyCollectorOptions = {}): SessionCollector {
  const liveWindowMs = opts.liveWindowMs ?? DEFAULT_LIVE_WINDOW_MS;
  const limit = opts.limit ?? DEFAULT_LIMIT;

  return {
    async collect(ctx: CollectContext): Promise<DiscoveredSession[]> {
      const { conversationsDir, lastConversationsFile } = pathsOf(opts, ctx);
      const now = ctx.now ?? Date.now();

      let entries: string[];
      try {
        entries = await fsp.readdir(conversationsDir);
      } catch {
        return []; // no antigravity home → nothing to enumerate (honest)
      }

      const cwdById = await readCwdByConversationId(lastConversationsFile);

      const collected: Array<{ session: DiscoveredSession; sort: number }> = [];
      await Promise.all(
        entries.map(async (name) => {
          // `.db` only — the `-shm`/`-wal` WAL sidecars end in `.db-shm`/`.db-wal`
          // and are excluded by the plain `.db` suffix test.
          if (!name.endsWith('.db')) return;
          const id = name.slice(0, -3);
          if (id.length === 0) return;
          const dbPath = path.join(conversationsDir, name);
          let mtimeMs: number;
          try {
            mtimeMs = (await fsp.stat(dbPath)).mtimeMs;
          } catch {
            return; // raced deletion
          }
          const cwd = cwdById.get(id);
          const session: DiscoveredSession = {
            id,
            tool: 'agy',
            live: now - mtimeMs < liveWindowMs,
            updatedAt: mtimeMs,
            ...(cwd ? { cwd } : {}),
            transcriptRef: { kind: 'opaque', handle: dbPath } as TranscriptRef,
          };
          collected.push({ session, sort: mtimeMs });
        }),
      );

      collected.sort((a, b) => b.sort - a.sort);
      return collected.slice(0, limit).map((c) => c.session);
    },

    watchPaths(ctx: CollectContext): string[] {
      const { conversationsDir } = pathsOf(opts, ctx);
      return [conversationsDir];
    },
  };
}
