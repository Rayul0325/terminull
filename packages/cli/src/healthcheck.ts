/**
 * Synthetic-event healthcheck (contract §D3b) — proves the WHOLE injected
 * chain, not just server liveness: it executes the actually-installed hook
 * artifact (Claude's `terminull-session-start.sh` / Codex's notify wrapper)
 * with a crafted input, pointed at the discovered panel port, then confirms the
 * event surfaced on the server's events feed.
 *
 * "Pointed at the discovered port" without clobbering the server-owned
 * `server.json`: we run the hook under a THROWAWAY `$HOME` whose
 * `.terminull/server.json` we write with `{ url }` = the discovered/fixture
 * panel. The hook's own `terminull-lib.sh` reads that file (its documented
 * discovery path), so the real injected script drives the real POST — against a
 * fixture listener in tests, or the real loopback server in production.
 *
 * Honest failure: missing `jq`/`curl`, a down panel, or no event within the
 * timeout is reported as such — never faked green.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { InjectableTool } from './injection.js';

/** Minimal shape of one row from `GET /api/events`. */
interface FeedEvent {
  seq: number;
  type?: string;
  sessionId?: string;
  tool?: string;
  payload?: Record<string, unknown>;
}

/** Result of {@link syntheticHealthcheck}. */
export interface HealthcheckResult {
  ok: boolean;
  /** `unavailable` = prerequisites missing (jq/curl); honest skip, not a fail. */
  status: 'passed' | 'not_observed' | 'unavailable';
  detail: string;
}

/** Injectable run seam so tests never shell out unexpectedly. */
export type ExecFileFn = (
  file: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; input?: string; timeoutMs: number },
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Default runner: node execFile with an stdin pipe + hard timeout. */
export const realExecFile: ExecFileFn = (file, args, opts) =>
  new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      { env: opts.env, timeout: opts.timeoutMs },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as { code?: number }).code === 'number'
            ? (err as { code: number }).code
            : err
              ? 1
              : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();
  });

function haveTool(bin: string): boolean {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, bin))) return true;
  }
  return false;
}

interface Invocation {
  args: string[];
  input?: string;
  matches(ev: FeedEvent, marker: string): boolean;
}

function invocationFor(tool: InjectableTool, marker: string): Invocation {
  if (tool === 'claude') {
    return {
      args: [],
      input: JSON.stringify({ session_id: marker, cwd: os.tmpdir(), source: 'startup' }),
      matches: (ev) => ev.sessionId === marker,
    };
  }
  // codex notify: `wrapper <realClient> <payload…>`; empty realClient = no chain-exec.
  return {
    args: ['', `turn-ended ${marker}`],
    matches: (ev) =>
      ev.type === 'codex.turn' && String(ev.payload?.['event'] ?? '').includes(marker),
  };
}

async function feedSince(
  url: string,
  since: number,
  fetchImpl: typeof fetch,
): Promise<{ events: FeedEvent[]; seq: number } | null> {
  try {
    const res = await fetchImpl(`${url}/api/events?since=${since}`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { events?: FeedEvent[]; seq?: number };
    return { events: Array.isArray(body.events) ? body.events : [], seq: body.seq ?? since };
  } catch {
    return null;
  }
}

/**
 * Run the injected hook for `tool` against `url` and confirm its event lands.
 * `scriptPath` is the installed artifact; `execFileImpl`/`fetchImpl` are seams.
 */
export async function syntheticHealthcheck(opts: {
  tool: InjectableTool;
  scriptPath: string;
  url: string;
  execFileImpl?: ExecFileFn;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<HealthcheckResult> {
  const { tool, scriptPath, url } = opts;
  const execFileImpl = opts.execFileImpl ?? realExecFile;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 4_000;

  if (!haveTool('jq') || !haveTool('curl')) {
    return {
      ok: false,
      status: 'unavailable',
      detail: 'jq/curl not on PATH — cannot exercise the injected hook',
    };
  }

  const marker = `tn-healthcheck-${Math.random().toString(16).slice(2, 14)}`;
  const invocation = invocationFor(tool, marker);

  // Throwaway HOME whose server.json points the hook at `url`.
  const fakeHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'tn-hc-'));
  try {
    const disc = path.join(fakeHome, '.terminull');
    await fsp.mkdir(disc, { recursive: true });
    await fsp.writeFile(
      path.join(disc, 'server.json'),
      JSON.stringify({ url, port: 0, pid: process.pid }, null, 2),
      { mode: 0o600 },
    );

    const before = await feedSince(url, 0, fetchImpl);
    if (before === null) {
      return { ok: false, status: 'not_observed', detail: `panel at ${url} did not answer` };
    }
    const sinceSeq = before.seq;

    await execFileImpl(scriptPath, invocation.args, {
      env: { ...process.env, HOME: fakeHome, TERMINULL_AGENT: '' },
      ...(invocation.input !== undefined ? { input: invocation.input } : {}),
      timeoutMs,
    });

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const feed = await feedSince(url, sinceSeq, fetchImpl);
      if (feed && feed.events.some((ev) => invocation.matches(ev, marker))) {
        return {
          ok: true,
          status: 'passed',
          detail: `synthetic ${tool} event observed on the panel`,
        };
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return {
      ok: false,
      status: 'not_observed',
      detail: `synthetic ${tool} event did not reach the panel within ${timeoutMs}ms`,
    };
  } finally {
    await fsp.rm(fakeHome, { recursive: true, force: true }).catch(() => {});
  }
}
