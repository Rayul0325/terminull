/**
 * Claude Code session collector — ports control-tower's
 * `server/collectors/claude.js` into the SDK {@link SessionCollector} contract.
 *
 * Live sessions come from `<claudeHome>/sessions/<PID>.json` (written by the CLI
 * itself); a registry entry whose PID is gone is stale and skipped. Recent
 * (not-necessarily-live) sessions come from transcript mtime under
 * `<claudeHome>/projects/`. Transcripts can exceed 60 MB, so only a tail window
 * is ever read for enrichment.
 *
 * `claudeHome` is configurable so tests point it at a fixture tree; it defaults
 * to `<ctx.home ?? os.homedir()>/.claude`.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  CollectContext,
  DiscoveredSession,
  SessionCollector,
  TranscriptRef,
} from '@terminull/adapter-sdk';

const TAIL_WINDOW = 64 * 1024;
const RECENT_LIMIT = 60;

/** Options for {@link createClaudeCollector}. */
export interface ClaudeCollectorOptions {
  /** Override the `.claude` home (defaults to `<ctx.home ?? homedir>/.claude`). */
  claudeHome?: string;
  /** Liveness probe (injectable for tests). Defaults to `process.kill(pid, 0)`. */
  pidAlive?: (pid: number) => boolean;
}

/** Default liveness probe: signal 0 tests existence without delivering a signal. */
function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Read the last `bytes` of a file without loading the whole thing. */
async function readTail(file: string, bytes = TAIL_WINDOW): Promise<string> {
  const fh = await fsp.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    if (len > 0) await fh.read(buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally {
    await fh.close();
  }
}

/** True iff `p` resolves to a readable regular file (never throws). */
async function isReadableFile(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isFile();
  } catch {
    return false;
  }
}

/** Extract the most recent occurrence of a JSON string field from raw text. */
function lastField(raw: string, field: string): string | null {
  const re = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'g');
  let m: RegExpExecArray | null;
  let last: string | null = null;
  while ((m = re.exec(raw)) !== null) last = m[1] ?? last;
  if (last === null) return null;
  try {
    return JSON.parse(`"${last}"`) as string;
  } catch {
    return last;
  }
}

function toEpoch(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Date.parse(v);
    if (!Number.isNaN(n)) return n;
  }
  return undefined;
}

interface RawEntry {
  session: DiscoveredSession;
  transcript: string;
  /** True when cwd was only dash-decoded (lossy) and needs transcript recovery. */
  cwdEncoded: boolean;
  sort: number;
}

/** Enrich a session from its transcript tail: real title + real cwd. */
async function enrich(entry: RawEntry): Promise<DiscoveredSession> {
  const s = entry.session;
  try {
    if (!fs.existsSync(entry.transcript)) return s;
    const tail = await readTail(entry.transcript);
    const title = lastField(tail, 'aiTitle');
    // Dash-encoding of project dirs is lossy — the transcript's own cwd field is
    // the only reliable way to recover paths containing dashes.
    const cwd = entry.cwdEncoded || !s.cwd ? lastField(tail, 'cwd') : null;
    return {
      ...s,
      ...(title ? { title } : {}),
      ...(cwd ? { cwd } : {}),
    };
  } catch {
    return s;
  }
}

/**
 * Build the transcript path for a live session, mirroring Claude Code's own
 * project-dir naming: EVERY non-alphanumeric char in the cwd is dash-encoded,
 * not just `/`. A naive `/`-only encoding left `.`, spaces and non-ASCII chars
 * intact (e.g. `/…/.claude/control-tower`, `/…/오픈랩 2026`), yielding a path
 * that does not exist — the transcript route's `fsp.open` then threw ENOENT and
 * the handler returned a blanket 502 `transcript_read_failed`. The encoding is
 * lossy, so the resolved path is existence-checked by the caller.
 */
function transcriptPathFor(projectsDir: string, cwd: string, sessionId: string): string {
  return path.join(projectsDir, cwd.replace(/[^A-Za-z0-9]/g, '-'), `${sessionId}.jsonl`);
}

/**
 * Create a Claude Code session collector. The returned {@link SessionCollector}
 * enumerates live sessions (PID registry) then recent ones (transcript mtime),
 * deduped so a live session never also appears as "recent".
 */
export function createClaudeCollector(opts: ClaudeCollectorOptions = {}): SessionCollector {
  const pidAlive = opts.pidAlive ?? defaultPidAlive;

  const homesOf = (ctx: CollectContext): { sessionsDir: string; projectsDir: string } => {
    const claudeHome = opts.claudeHome ?? path.join(ctx.home ?? os.homedir(), '.claude');
    return {
      sessionsDir: path.join(claudeHome, 'sessions'),
      projectsDir: path.join(claudeHome, 'projects'),
    };
  };

  async function collectLive(projectsDir: string, sessionsDir: string): Promise<RawEntry[]> {
    let files: string[] = [];
    try {
      files = await fsp.readdir(sessionsDir);
    } catch {
      return [];
    }
    // Dedup: a resumed session can leave two live registry entries — keep the
    // most recently updated.
    const bySession = new Map<string, RawEntry>();
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const j = JSON.parse(await fsp.readFile(path.join(sessionsDir, f), 'utf8')) as Record<
          string,
          unknown
        >;
        const pid = typeof j['pid'] === 'number' ? j['pid'] : Number(j['pid']);
        const sessionId = typeof j['sessionId'] === 'string' ? j['sessionId'] : undefined;
        if (!sessionId || !Number.isFinite(pid) || !pidAlive(pid)) continue;
        const cwd = typeof j['cwd'] === 'string' ? j['cwd'] : undefined;
        const updatedAt =
          toEpoch(j['updatedAt']) ?? toEpoch(j['statusUpdatedAt']) ?? toEpoch(j['startedAt']);
        const transcript = cwd ? transcriptPathFor(projectsDir, cwd, sessionId) : '';
        // Only advertise a transcriptRef the parser can actually open. A path
        // that does not resolve to a readable file (encoding edge, deleted, or a
        // live transcript not yet written) is omitted so the transcript route
        // returns an honest `supported:false` — never a 502 from an ENOENT open.
        const hasTranscript = transcript ? await isReadableFile(transcript) : false;
        const session: DiscoveredSession = {
          id: sessionId,
          tool: 'claude',
          live: true,
          ...(cwd ? { cwd } : {}),
          ...(typeof j['name'] === 'string' && j['name'] ? { title: j['name'] } : {}),
          ...(updatedAt !== undefined ? { updatedAt } : {}),
          ...(hasTranscript
            ? { transcriptRef: { kind: 'file', path: transcript } as TranscriptRef }
            : {}),
        };
        const prev = bySession.get(sessionId);
        if (prev && (prev.session.updatedAt ?? 0) >= (updatedAt ?? 0)) continue;
        bySession.set(sessionId, {
          session,
          transcript,
          cwdEncoded: false,
          sort: updatedAt ?? 0,
        });
      } catch {
        /* unreadable registry entry — skip */
      }
    }
    return [...bySession.values()];
  }

  async function collectRecent(projectsDir: string, exclude: Set<string>): Promise<RawEntry[]> {
    let dirs: string[] = [];
    try {
      dirs = await fsp.readdir(projectsDir);
    } catch {
      return [];
    }
    const candidates: RawEntry[] = [];
    await Promise.all(
      dirs.map(async (d) => {
        const dp = path.join(projectsDir, d);
        let entries: string[];
        try {
          entries = await fsp.readdir(dp);
        } catch {
          return;
        }
        await Promise.all(
          entries.map(async (e) => {
            if (!e.endsWith('.jsonl')) return;
            const sid = e.slice(0, -6);
            if (exclude.has(sid)) return;
            const file = path.join(dp, e);
            try {
              const st = await fsp.stat(file);
              candidates.push({
                session: {
                  id: sid,
                  tool: 'claude',
                  live: false,
                  updatedAt: st.mtimeMs,
                  transcriptRef: { kind: 'file', path: file } as TranscriptRef,
                },
                transcript: file,
                cwdEncoded: true, // dir name is dash-encoded; recover cwd via enrich
                sort: st.mtimeMs,
              });
            } catch {
              /* raced deletion */
            }
          }),
        );
      }),
    );
    candidates.sort((a, b) => b.sort - a.sort);
    return candidates.slice(0, RECENT_LIMIT);
  }

  return {
    async collect(ctx: CollectContext): Promise<DiscoveredSession[]> {
      const { sessionsDir, projectsDir } = homesOf(ctx);
      const live = await collectLive(projectsDir, sessionsDir);
      const liveIds = new Set(live.map((e) => e.session.id));
      const recent = await collectRecent(projectsDir, liveIds);
      return Promise.all([...live, ...recent].map(enrich));
    },
    watchPaths(ctx: CollectContext): string[] {
      const { sessionsDir, projectsDir } = homesOf(ctx);
      return [sessionsDir, projectsDir];
    },
  };
}
