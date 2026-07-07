/**
 * Codex app-server client — delivers a GUI directive to a DISCOVERED codex
 * session by its id.
 *
 * Codex has no pid registry (unlike Claude), so a discovered session cannot be
 * resolved to a tmux pane for keystroke injection. But the app-server protocol
 * keys everything on the SAME id we already display: a discovered session's id
 * IS the rollout uuid IS the app-server `threadId`. So injection needs no
 * pane/pid join at all — `turn/start({ threadId, input })` uses the id directly.
 *
 * Transport: we spawn our OWN `codex app-server` over stdio (newline-delimited
 * JSON-RPC — verified empirically; NOT LSP Content-Length). A fresh instance
 * reads the disk-persisted threads, so we never touch the desktop-managed
 * daemon (connecting to its control socket is rejected) and never enable
 * remote control. The turn runs and is persisted to the rollout; Terminull
 * renders the result by reading that rollout.
 *
 * Everything is failure-isolated: a missing codex binary, a spawn error, a
 * timeout, an unknown/active thread, or a protocol error resolves to
 * `'unsupported'` — the caller then queues honestly and NEVER fabricates a
 * delivery.
 */
import { type ChildProcessWithoutNullStreams, spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type InjectResult = 'delivered' | 'unsupported';

export interface AppServerClientOptions {
  /** codex binary path (default: resolve `~/.npm-global/bin/codex` then PATH). */
  codexBin?: string;
  /** Injectable spawn for tests. */
  spawn?: (bin: string, args: string[]) => ChildProcessWithoutNullStreams;
  /** Overall budget for the initialize→resume→turn/start handshake. */
  timeoutMs?: number;
}

/** Resolve the codex binary; null when not installed (caller → unsupported). */
export function resolveCodexBin(): string | null {
  const npmGlobal = path.join(os.homedir(), '.npm-global/bin/codex');
  try {
    fs.accessSync(npmGlobal, fs.constants.X_OK);
    return npmGlobal;
  } catch {
    /* fall through to PATH */
  }
  for (const dir of (process.env['PATH'] ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const full = path.join(dir, 'codex');
    try {
      fs.accessSync(full, fs.constants.X_OK);
      return full;
    } catch {
      /* keep searching */
    }
  }
  return null;
}

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string };
  method?: string;
}

/**
 * A newline-delimited JSON-RPC session over a spawned `codex app-server`.
 * Requests correlate by numeric id; notifications (no id) are ignored.
 */
class AppServerSession {
  private readonly proc: ChildProcessWithoutNullStreams;
  private buf = '';
  private nextId = 1;
  private readonly pending = new Map<number, (r: JsonRpcResponse) => void>();
  private closed = false;

  constructor(bin: string, spawnFn: NonNullable<AppServerClientOptions['spawn']>) {
    this.proc = spawnFn(bin, ['app-server']);
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk: string) => this.onData(chunk));
    // Never let a dead pipe/child crash the server.
    this.proc.on('error', () => this.fail());
    this.proc.stderr.on('data', () => {
      /* codex logs to stderr; swallow */
    });
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    for (;;) {
      const nl = this.buf.indexOf('\n');
      if (nl < 0) break;
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(line) as JsonRpcResponse;
      } catch {
        continue; // ignore non-JSON log noise
      }
      if (typeof msg.id === 'number') {
        const resolve = this.pending.get(msg.id);
        if (resolve) {
          this.pending.delete(msg.id);
          resolve(msg);
        }
      }
      // notifications (no id) are not needed for one-shot injection
    }
  }

  private fail(): void {
    if (this.closed) return;
    for (const resolve of this.pending.values())
      resolve({ error: { message: 'app-server closed' } });
    this.pending.clear();
  }

  /** Send a request and await its response (or a per-call timeout). */
  request(method: string, params: unknown, timeoutMs: number): Promise<JsonRpcResponse> {
    if (this.closed) return Promise.resolve({ error: { message: 'closed' } });
    const id = this.nextId++;
    return new Promise<JsonRpcResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ error: { message: 'timeout' } });
      }, timeoutMs);
      this.pending.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      try {
        this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ error: { message: 'write failed' } });
      }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.proc.stdin.end();
    } catch {
      /* ignore */
    }
    this.proc.kill();
  }
}

/**
 * Deliver `text` to the codex session `threadId` (= the discovered session id).
 * Resolves to `'delivered'` only when the app-server accepted a `turn/start`;
 * any failure (no codex, spawn error, unknown thread, active thread, protocol
 * error, timeout) → `'unsupported'` so the caller queues honestly.
 */
export async function injectDirective(
  threadId: string,
  text: string,
  opts: AppServerClientOptions = {},
): Promise<InjectResult> {
  const bin = opts.codexBin ?? resolveCodexBin();
  if (!bin) return 'unsupported';
  // The panel often runs under a minimal launchd PATH (`/usr/bin:/bin:…`) with
  // no node on it; codex's `#!/usr/bin/env node` shebang (and the native binary
  // it re-execs) would then fail to start. Put OUR node's dir on the child's
  // PATH so the spawn works regardless of how the panel was launched.
  const defaultSpawn: NonNullable<AppServerClientOptions['spawn']> = (b, a) =>
    nodeSpawn(b, a, {
      env: {
        ...process.env,
        PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env['PATH'] ?? ''}`,
      },
    });
  const spawnFn = opts.spawn ?? defaultSpawn;
  const budget = opts.timeoutMs ?? 15000;
  const perCall = Math.max(2000, Math.floor(budget / 3));

  let session: AppServerSession;
  try {
    session = new AppServerSession(bin, spawnFn);
  } catch {
    return 'unsupported';
  }
  try {
    const init = await session.request(
      'initialize',
      { clientInfo: { name: 'terminull', version: '1' }, capabilities: null },
      perCall,
    );
    if (init.error || !init.result) return 'unsupported';

    // Load the thread from disk by its id. A running thread is REJOINED by the
    // app-server; an idle/notLoaded one loads cleanly. Unknown id → error.
    const resume = await session.request('thread/resume', { threadId }, perCall);
    if (resume.error || !resume.result) return 'unsupported';

    const started = await session.request(
      'turn/start',
      { threadId, input: [{ type: 'text', text, text_elements: [] }] },
      perCall,
    );
    if (started.error || !started.result) return 'unsupported';
    return 'delivered';
  } catch {
    return 'unsupported';
  } finally {
    session.close();
  }
}
