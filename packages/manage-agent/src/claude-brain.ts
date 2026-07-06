/**
 * ClaudeBrainAdapter — the v1 brain backend over the Claude Code CLI in
 * headless mode: `claude -p --output-format stream-json --verbose`.
 *
 * Design constraints (M7 contract):
 *  - spawned via `child_process.spawn`, NEVER through a shell; cwd-neutral
 *    (defaults to the OS tmpdir so the panel repo's project config never
 *    leaks into supervisor turns);
 *  - model comes from configuration with a 'sonnet' default — never a
 *    hardcoded top-tier model;
 *  - stream-json records are parsed into {@link BrainEvent}s; the `result`
 *    record's `total_cost_usd` is folded into a `usage` event (honest cost:
 *    absent means unknown, never fabricated);
 *  - AbortSignal / turn timeout → clean kill (SIGTERM, SIGKILL after a
 *    grace period) and a terminal `done` event;
 *  - unit tests inject {@link ClaudeBrainOptions.spawnFn} with a scripted
 *    child — they never spawn the real CLI.
 *
 * Proposal convention (documented in the system prompt, see `prompt.ts`):
 * a single line `ACTION: {"action": {...}, "reason": "..."}` inside the
 * assistant text. The extracted `action` value stays `unknown` — the
 * supervisor loop zod-parses it; an unparseable payload is still surfaced as
 * an action event so the loop denies it AUDITED instead of silently dropping.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import os from 'node:os';
import type { Readable, Writable } from 'node:stream';
import type { LocalizedText } from '@terminull/shared';
import type { BrainAdapter, BrainEvent, BrainProbe, BrainTurnInput } from './index.js';
import { ACTION_LINE_PREFIX } from './prompt.js';

// ---------------------------------------------------------------------------
// Spawn seam (injected in tests)
// ---------------------------------------------------------------------------

/** The minimal child-process surface the adapter needs (stubbable). */
export interface BrainChildProcess {
  stdout: Readable | null;
  stderr: Readable | null;
  stdin: Writable | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

/** Options the adapter passes to its spawner. No `shell` — by design. */
export interface BrainSpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdio: ['pipe' | 'ignore', 'pipe', 'pipe'];
}

/** Spawner signature; tests inject a scripted fake, prod uses node's spawn. */
export type BrainSpawn = (
  command: string,
  args: readonly string[],
  options: BrainSpawnOptions,
) => BrainChildProcess;

/** Production spawner — a thin wrapper keeping the seam type exact. */
const defaultSpawn: BrainSpawn = (command, args, options) =>
  nodeSpawn(command, [...args], options);

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Construction options for {@link ClaudeBrainAdapter}. */
export interface ClaudeBrainOptions {
  /** Model passed as `--model`. Default `'sonnet'` (never a hardcoded top tier). */
  model?: string;
  /** CLI binary name/path. Default `'claude'`. */
  binary?: string;
  /** Subprocess cwd. Default `os.tmpdir()` — neutral, never the panel repo. */
  cwd?: string;
  /** Wall-clock cap for one turn, ms. Default 120 000. */
  turnTimeoutMs?: number;
  /** Wall-clock cap for `--version` probe, ms. Default 5 000. */
  probeTimeoutMs?: number;
  /** Grace between SIGTERM and SIGKILL on abort/timeout, ms. Default 2 000. */
  killGraceMs?: number;
  /** Injected spawner — REQUIRED in unit tests (never the real CLI). */
  spawnFn?: BrainSpawn;
  /** Subprocess environment. Default: inherit `process.env`. */
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_MODEL = 'sonnet';
const DEFAULT_BINARY = 'claude';
const DEFAULT_TURN_TIMEOUT_MS = 120_000;
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_KILL_GRACE_MS = 2_000;
/** Keep stderr captured for diagnostics bounded. */
const STDERR_TAIL_LIMIT = 2_000;

function unavailable(detailEn: string): BrainProbe {
  const detail: LocalizedText = {
    en: `claude CLI unavailable: ${detailEn}`,
    ko: `claude CLI를 사용할 수 없습니다: ${detailEn}`,
  };
  return { availability: 'unavailable', detail };
}

// ---------------------------------------------------------------------------
// stream-json line parsing
// ---------------------------------------------------------------------------

/** Parse one NDJSON line of `--output-format stream-json` into brain events. */
export function parseStreamJsonLine(line: string): BrainEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let record: unknown;
  try {
    record = JSON.parse(trimmed);
  } catch {
    // Non-JSON noise on stdout (should not happen in stream-json) — ignore.
    return [];
  }
  if (record === null || typeof record !== 'object') return [];
  const rec = record as Record<string, unknown>;
  switch (rec.type) {
    case 'assistant':
      return eventsFromAssistant(rec);
    case 'result':
      return eventsFromResult(rec);
    default:
      // system/init, user (tool results), etc. — no brain-visible event.
      return [];
  }
}

function eventsFromAssistant(rec: Record<string, unknown>): BrainEvent[] {
  const message = rec.message;
  if (message === null || typeof message !== 'object') return [];
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return [];
  const events: BrainEvent[] = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (b.type === 'text' && typeof b.text === 'string') {
      events.push(...eventsFromAssistantText(b.text));
    }
  }
  return events;
}

const ACTION_LINE_RE = new RegExp(`^\\s*${ACTION_LINE_PREFIX}\\s*(.*\\S)\\s*$`);

/** Split assistant text into interleaved text/action events (v1 convention). */
function eventsFromAssistantText(text: string): BrainEvent[] {
  const events: BrainEvent[] = [];
  let buffer: string[] = [];
  const flushText = () => {
    const chunk = buffer.join('\n');
    buffer = [];
    if (chunk.trim().length > 0) events.push({ kind: 'text', text: chunk });
  };
  for (const line of text.split('\n')) {
    const match = ACTION_LINE_RE.exec(line);
    if (!match) {
      buffer.push(line);
      continue;
    }
    flushText();
    events.push(actionEventFromPayload(match[1] ?? ''));
  }
  flushText();
  return events;
}

function actionEventFromPayload(payload: string): BrainEvent {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (parsed !== null && typeof parsed === 'object' && 'action' in parsed) {
      const envelope = parsed as { action: unknown; reason?: unknown };
      return {
        kind: 'action',
        action: envelope.action,
        ...(typeof envelope.reason === 'string' ? { reason: envelope.reason } : {}),
      };
    }
    // Bare object without the envelope — still surfaced; zod gates upstream.
    return { kind: 'action', action: parsed };
  } catch {
    // Unparseable payload: surface it so the loop DENIES it with an audit
    // event, rather than silently swallowing a proposal attempt.
    return { kind: 'action', action: payload };
  }
}

function eventsFromResult(rec: Record<string, unknown>): BrainEvent[] {
  const events: BrainEvent[] = [];
  const usage: { kind: 'usage'; costUsd?: number; inputTokens?: number; outputTokens?: number } = {
    kind: 'usage',
  };
  if (typeof rec.total_cost_usd === 'number' && Number.isFinite(rec.total_cost_usd)) {
    usage.costUsd = rec.total_cost_usd;
  }
  if (rec.usage !== null && typeof rec.usage === 'object') {
    const u = rec.usage as Record<string, unknown>;
    if (typeof u.input_tokens === 'number') usage.inputTokens = u.input_tokens;
    if (typeof u.output_tokens === 'number') usage.outputTokens = u.output_tokens;
  }
  if (usage.costUsd !== undefined || usage.inputTokens !== undefined || usage.outputTokens !== undefined) {
    events.push(usage);
  }
  if (rec.is_error === true || rec.subtype !== 'success') {
    events.push({
      kind: 'error',
      code: typeof rec.subtype === 'string' ? rec.subtype : 'result_error',
      ...(typeof rec.result === 'string' ? { detail: rec.result } : {}),
    });
    events.push({ kind: 'done', stopReason: 'error' });
  } else {
    events.push({ kind: 'done', stopReason: 'end_turn' });
  }
  return events;
}

/** Render one turn's input as the single stdin prompt for `claude -p`. */
export function composeTurnPrompt(input: BrainTurnInput): string {
  const parts = [input.system];
  for (const message of input.messages) {
    const role = message.role === 'user' ? 'User' : 'Supervisor (you)';
    parts.push(`## ${role}\n\n${message.text}`);
  }
  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/** Headless Claude CLI brain. See module doc for the full contract. */
export class ClaudeBrainAdapter implements BrainAdapter {
  readonly id = 'claude-headless';

  private readonly model: string;
  private readonly binary: string;
  private readonly cwd: string;
  private readonly turnTimeoutMs: number;
  private readonly probeTimeoutMs: number;
  private readonly killGraceMs: number;
  private readonly spawnFn: BrainSpawn;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: ClaudeBrainOptions = {}) {
    this.model = options.model ?? DEFAULT_MODEL;
    this.binary = options.binary ?? DEFAULT_BINARY;
    this.cwd = options.cwd ?? os.tmpdir();
    this.turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    this.probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.spawnFn = options.spawnFn ?? defaultSpawn;
    this.env = options.env ?? process.env;
  }

  /** `claude --version` — `'ok'` ONLY on exit 0 with real output. */
  probe(): Promise<BrainProbe> {
    return new Promise((resolve) => {
      let child: BrainChildProcess;
      try {
        child = this.spawnFn(this.binary, ['--version'], {
          cwd: this.cwd,
          env: this.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        resolve(unavailable(err instanceof Error ? err.message : String(err)));
        return;
      }
      let out = '';
      let errOut = '';
      let settled = false;
      const settle = (probe: BrainProbe) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(probe);
      };
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // Already gone — nothing to kill.
        }
        settle(unavailable(`probe timed out after ${this.probeTimeoutMs}ms`));
      }, this.probeTimeoutMs);
      timer.unref?.();
      child.stdout?.on('data', (chunk: Buffer | string) => {
        out += chunk.toString();
      });
      child.stderr?.on('data', (chunk: Buffer | string) => {
        errOut += chunk.toString();
      });
      child.on('error', (err) => settle(unavailable(err.message)));
      child.on('close', (code) => {
        const version = out.trim();
        if (code === 0 && version.length > 0) {
          settle({ availability: 'ok', version });
        } else {
          settle(unavailable(errOut.trim() || `exit code ${String(code)}, no version output`));
        }
      });
    });
  }

  /** One headless turn. Terminal event is always a `done` (or stream end). */
  async *runTurn(input: BrainTurnInput, signal?: AbortSignal): AsyncIterable<BrainEvent> {
    if (signal?.aborted) {
      yield { kind: 'done', stopReason: 'interrupted' };
      return;
    }

    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--model', this.model];
    let child: BrainChildProcess;
    try {
      child = this.spawnFn(this.binary, args, {
        cwd: this.cwd,
        env: this.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      yield { kind: 'error', code: 'spawn_error', detail: err instanceof Error ? err.message : String(err) };
      yield { kind: 'done', stopReason: 'error' };
      return;
    }

    // Event queue bridging child callbacks → this async generator.
    const queue: BrainEvent[] = [];
    let wake: (() => void) | null = null;
    let closed = false;
    let doneQueued = false;
    let killTimer: NodeJS.Timeout | null = null;
    const notify = () => {
      const w = wake;
      wake = null;
      w?.();
    };
    const push = (event: BrainEvent) => {
      if (doneQueued) return; // nothing may follow the terminal event
      if (event.kind === 'done') doneQueued = true;
      queue.push(event);
      notify();
    };
    const killChild = () => {
      if (closed) return;
      try {
        child.kill('SIGTERM');
      } catch {
        // Already gone — nothing to kill.
      }
      if (killTimer === null) {
        killTimer = setTimeout(() => {
          if (closed) return;
          try {
            child.kill('SIGKILL');
          } catch {
            // Already gone — nothing to kill.
          }
        }, this.killGraceMs);
        killTimer.unref?.();
      }
    };

    let stderrTail = '';
    let lineBuffer = '';
    const handleLine = (line: string) => {
      for (const event of parseStreamJsonLine(line)) push(event);
    };

    child.stdout?.on('data', (chunk: Buffer | string) => {
      lineBuffer += chunk.toString();
      let newline = lineBuffer.indexOf('\n');
      while (newline >= 0) {
        handleLine(lineBuffer.slice(0, newline));
        lineBuffer = lineBuffer.slice(newline + 1);
        newline = lineBuffer.indexOf('\n');
      }
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_LIMIT);
    });
    child.on('error', (err) => {
      push({ kind: 'error', code: 'spawn_error', detail: err.message });
      push({ kind: 'done', stopReason: 'error' });
      closed = true;
      notify();
    });
    child.on('close', (code) => {
      closed = true;
      if (lineBuffer.length > 0) handleLine(lineBuffer);
      if (!doneQueued) {
        // Stream ended without a `result` record — honest error, not success.
        push({
          kind: 'error',
          code: `exit_${String(code)}`,
          ...(stderrTail.trim().length > 0 ? { detail: stderrTail.trim() } : {}),
        });
        push({ kind: 'done', stopReason: 'error' });
      }
      notify();
    });

    const onAbort = () => {
      push({ kind: 'done', stopReason: 'interrupted' });
      killChild();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const turnTimer = setTimeout(() => {
      push({ kind: 'error', code: 'timeout', detail: `turn exceeded ${this.turnTimeoutMs}ms` });
      push({ kind: 'done', stopReason: 'error' });
      killChild();
    }, this.turnTimeoutMs);
    turnTimer.unref?.();

    // Deliver the composed prompt on stdin (argv would leak into `ps` and
    // hit platform arg-length limits).
    try {
      child.stdin?.write(composeTurnPrompt(input));
      child.stdin?.end();
    } catch {
      // EPIPE when the child died instantly — the error/close path reports it.
    }

    try {
      for (;;) {
        const event = queue.shift();
        if (event) {
          yield event;
          if (event.kind === 'done') return;
          continue;
        }
        if (closed) return; // stream ended; terminal event already yielded
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      clearTimeout(turnTimer);
      if (killTimer !== null) clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
      killChild();
    }
  }
}
