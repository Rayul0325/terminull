/**
 * Agent-side session collector for `paneld agent` (M8 remote-collect).
 *
 * Answers the relay-terminated `collect` CTRL with THIS machine's tool
 * sessions, shaped as {@link RemoteSession}s (the strict wire mirror of
 * DiscoveredSession, minus transcriptRef — remote transcripts are v1
 * unsupported). Self-contained on purpose: the session-host must stay a leaf
 * package (shared + node-pty only), so this ports the minimal discovery rules
 * of the claude/codex adapters instead of importing them.
 *
 * Honesty rules:
 *  - A tool home that does not exist is a SUCCESSFUL zero-session scan
 *    (`ok:true, sessions:0`) — the tool genuinely has nothing here. Only a
 *    scan that THROWS reports `ok:false, error:'collector_failed'`.
 *  - `live` is true ONLY when verified via the local pid registry
 *    (claude). Codex exposes no liveness API — its sessions are reported
 *    `live:false` rather than dressing an mtime heuristic up as a fact.
 *  - Only session registries/filenames/mtimes are read. Credential files
 *    (auth.json, tokens, keys) are never opened.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Collected, RemoteAdapterStatus, RemoteSession } from '@terminull/shared';

/** Newest-first cap per tool, mirroring the local adapters' recent limits. */
const CLAUDE_RECENT_LIMIT = 60;
const CODEX_RECENT_LIMIT = 40;

/** rollout filename → codex session id (uuid suffix after the timestamp). */
const CODEX_SID_RE =
  /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

/** Options for {@link createAgentCollector}. */
export interface AgentCollectorOptions {
  /** Home dir whose `.claude`/`.codex` tool homes are scanned (tests: tmpdir). */
  home?: string;
  /** Liveness probe (injectable for tests). Defaults to `process.kill(pid, 0)`. */
  pidAlive?: (pid: number) => boolean;
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function toEpoch(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.round(v);
  if (typeof v === 'string') {
    const n = Date.parse(v);
    if (!Number.isNaN(n)) return n;
  }
  return undefined;
}

/** readdir that treats an absent/unreadable dir as empty (honest zero). */
async function readdirOrEmpty(dir: string): Promise<string[]> {
  try {
    return await fsp.readdir(dir);
  } catch {
    return [];
  }
}

/**
 * Claude Code: live sessions from the `<home>/.claude/sessions/<pid>.json`
 * registry (pid-verified), recent ones from transcript mtimes under
 * `<home>/.claude/projects/`. Transcript BODIES are never read here — titles
 * come from the registry's own `name` field only.
 */
async function collectClaude(
  home: string,
  pidAlive: (pid: number) => boolean,
): Promise<RemoteSession[]> {
  const claudeHome = path.join(home, '.claude');
  const sessionsDir = path.join(claudeHome, 'sessions');
  const projectsDir = path.join(claudeHome, 'projects');

  const live = new Map<string, RemoteSession>();
  for (const f of await readdirOrEmpty(sessionsDir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const j = JSON.parse(await fsp.readFile(path.join(sessionsDir, f), 'utf8')) as Record<
        string,
        unknown
      >;
      const pid = typeof j['pid'] === 'number' ? j['pid'] : Number(j['pid']);
      const id = typeof j['sessionId'] === 'string' ? j['sessionId'] : undefined;
      if (!id || !Number.isFinite(pid) || !pidAlive(pid)) continue;
      const updatedAt =
        toEpoch(j['updatedAt']) ?? toEpoch(j['statusUpdatedAt']) ?? toEpoch(j['startedAt']);
      const session: RemoteSession = {
        id,
        tool: 'claude',
        live: true,
        ...(typeof j['cwd'] === 'string' && j['cwd'] ? { cwd: j['cwd'] } : {}),
        ...(typeof j['name'] === 'string' && j['name'] ? { title: j['name'] } : {}),
        ...(updatedAt !== undefined ? { updatedAt } : {}),
      };
      const prev = live.get(id);
      if (prev && (prev.updatedAt ?? 0) >= (updatedAt ?? 0)) continue;
      live.set(id, session);
    } catch {
      /* unreadable registry entry — skip */
    }
  }

  const recent: RemoteSession[] = [];
  for (const d of await readdirOrEmpty(projectsDir)) {
    for (const e of await readdirOrEmpty(path.join(projectsDir, d))) {
      if (!e.endsWith('.jsonl')) continue;
      const id = e.slice(0, -6);
      if (live.has(id)) continue;
      try {
        const st = await fsp.stat(path.join(projectsDir, d, e));
        recent.push({ id, tool: 'claude', live: false, updatedAt: Math.round(st.mtimeMs) });
      } catch {
        /* raced deletion */
      }
    }
  }
  recent.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

  return [...live.values(), ...recent.slice(0, CLAUDE_RECENT_LIMIT)];
}

/**
 * Codex CLI: rollout transcripts under `<home>/.codex/sessions/YYYY/MM/DD/`
 * (newest mtime wins per session id), titles from `session_index.jsonl`
 * (append-ordered; later lines win). No liveness API exists, so every codex
 * session is reported `live:false` — never an mtime guess dressed as a fact.
 */
async function collectCodex(home: string): Promise<RemoteSession[]> {
  const codexHome = path.join(home, '.codex');
  const sessionsDir = path.join(codexHome, 'sessions');

  const newest = new Map<string, number>();
  for (const y of await readdirOrEmpty(sessionsDir)) {
    for (const m of await readdirOrEmpty(path.join(sessionsDir, y))) {
      for (const d of await readdirOrEmpty(path.join(sessionsDir, y, m))) {
        const dayDir = path.join(sessionsDir, y, m, d);
        for (const f of await readdirOrEmpty(dayDir)) {
          const sid = CODEX_SID_RE.exec(f)?.[1];
          if (!sid) continue;
          try {
            const st = await fsp.stat(path.join(dayDir, f));
            const mtime = Math.round(st.mtimeMs);
            if (mtime > (newest.get(sid) ?? -1)) newest.set(sid, mtime);
          } catch {
            /* raced deletion */
          }
        }
      }
    }
  }
  if (newest.size === 0) return [];

  const titles = new Map<string, string>();
  try {
    const index = await fsp.readFile(path.join(codexHome, 'session_index.jsonl'), 'utf8');
    for (const line of index.split('\n')) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line) as Record<string, unknown>;
        const id = typeof j['id'] === 'string' ? j['id'] : undefined;
        const name = typeof j['thread_name'] === 'string' ? j['thread_name'] : undefined;
        if (id && name) titles.set(id, name); // later lines win
      } catch {
        /* torn append — skip the line */
      }
    }
  } catch {
    /* no index — sessions stay untitled */
  }

  return [...newest.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, CODEX_RECENT_LIMIT)
    .map(([id, updatedAt]) => {
      const title = titles.get(id);
      return { id, tool: 'codex', live: false, updatedAt, ...(title ? { title } : {}) };
    });
}

/**
 * Build the collector `paneld agent` wires into the relay: one call = one
 * honest `collected` body (`supported:true` — the scans themselves degrade
 * per-adapter, never the whole reply).
 */
export function createAgentCollector(
  opts: AgentCollectorOptions = {},
): () => Promise<Omit<Collected, 't' | 'reqId'>> {
  const home = opts.home ?? os.homedir();
  const pidAlive = opts.pidAlive ?? defaultPidAlive;

  const scans: Array<{ adapterId: string; scan: () => Promise<RemoteSession[]> }> = [
    { adapterId: 'claude', scan: () => collectClaude(home, pidAlive) },
    { adapterId: 'codex', scan: () => collectCodex(home) },
  ];

  return async () => {
    const adapters: RemoteAdapterStatus[] = [];
    const sessions: RemoteSession[] = [];
    for (const { adapterId, scan } of scans) {
      try {
        const found = await scan();
        adapters.push({ adapterId, ok: true, sessions: found.length });
        sessions.push(...found);
      } catch {
        // The scan itself blew up (absent homes are handled INSIDE the scan
        // as honest zeros) — report the failure, contribute no sessions.
        adapters.push({ adapterId, ok: false, error: 'collector_failed', sessions: 0 });
      }
    }
    return { supported: true, adapters, sessions };
  };
}
