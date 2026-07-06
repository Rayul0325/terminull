/**
 * The Codex CLI driver — two independent channels.
 *
 * (a) {@link CodexHeadlessRunner}: a non-interactive turn runner over
 *     `codex exec --json`. It delivers a directive to a NON-live session (with
 *     `-C <cwd>`), or resumes one by id (`codex exec resume <id>`), streaming the
 *     JSONL event log and extracting the final agent message. This is how the
 *     panel talks to a Codex session it does not have a live TUI for.
 *
 * (b) {@link CodexPtyDriver}: a PTY keymap driver for an ADOPTED live TUI
 *     session, modelled on the generic adapter. It drives raw keystrokes via a
 *     caller-supplied injector (so this package never imports the session-host).
 *     `interrupt()` is Ctrl+C (Codex's turn-stop). `detectPromptState` is
 *     best-effort: it recognises Codex's y/n approval prompt and is HONESTLY
 *     `unknown` otherwise. `answerMenu` answers only a detected approval menu,
 *     else rejects with {@link MenuNotPresentError} — never blind keystrokes.
 *     `rename`/`background`/`approvePlan`/`setPermissionMode` are typed
 *     {@link AdapterUnsupportedError}s (Codex has no such TUI affordance; see the
 *     rename gap note below).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import {
  AdapterUnsupportedError,
  MenuNotPresentError,
  UnknownKeyError,
  type AnswerMenuOptions,
  type Driver,
  type Keymap,
  type KeyInjector,
  type MenuOption,
  type NamedKey,
  type PromptState,
  type SendTextOptions,
} from '@terminull/adapter-sdk';

const encoder = new TextEncoder();
const ENTER_BYTES = Uint8Array.from([0x0d]);
const YES_BYTES = Uint8Array.from([0x79]); // 'y'
const NO_BYTES = Uint8Array.from([0x6e]); // 'n'

// ---------------------------------------------------------------------------
// (b) PTY driver
// ---------------------------------------------------------------------------

/** Codex's approval prompt, best-effort. Distinctive enough to avoid blind keys. */
const APPROVAL_RE =
  /\b(allow (this )?command|approve this|run this command|\[y\/n\]|\(y\/n\)|press y to|y\/n\?)/i;
/** Codex's working indicator, best-effort. */
const BUSY_RE = /\besc to interrupt\b|\bworking…|\bthinking…|\besc to cancel\b/i;

/** Drives an adopted live Codex TUI session over the injected IN channel. */
export class CodexPtyDriver implements Driver {
  constructor(
    private readonly keymap: Keymap,
    private readonly inject: KeyInjector,
  ) {}

  private bytesFor(key: NamedKey): Uint8Array {
    const binding = this.keymap[key];
    if (!binding) throw new UnknownKeyError(key);
    return binding.bytes;
  }

  async sendText(opts: SendTextOptions): Promise<void> {
    await this.inject(encoder.encode(opts.text));
    if (opts.submit) {
      const enter = this.keymap.Enter;
      await this.inject(enter ? enter.bytes : ENTER_BYTES);
    }
  }

  async sendKey(key: NamedKey): Promise<void> {
    await this.inject(this.bytesFor(key));
  }

  async answerMenu(opts: AnswerMenuOptions): Promise<void> {
    const state = this.detectPromptState(opts.screen);
    if (state.kind !== 'menu') throw new MenuNotPresentError(state.kind);
    // Codex's only recognised menu is the binary y/n approval. Choice 0 = yes.
    const choice = Array.isArray(opts.choice) ? (opts.choice[0] ?? 0) : opts.choice;
    if (choice < 0 || choice >= state.options.length) {
      throw new RangeError(`choice ${choice} out of range (${state.options.length} options)`);
    }
    await this.inject(choice === 0 ? YES_BYTES : NO_BYTES);
    await this.inject(this.bytesFor('Enter'));
  }

  async approvePlan(): Promise<void> {
    // Codex has no plan-mode approval prompt (that is a Claude affordance).
    throw new AdapterUnsupportedError('approvePlan');
  }

  async setPermissionMode(): Promise<void> {
    // Sandbox/approval policy is chosen at launch (`--sandbox`/`--ask-for-approval`),
    // not cycled via a TUI key.
    throw new AdapterUnsupportedError('setPermissionMode');
  }

  async interrupt(): Promise<void> {
    // Codex stops the current turn on Ctrl+C (a second press quits).
    await this.inject(this.bytesFor('CtrlC'));
  }

  async background(): Promise<void> {
    throw new AdapterUnsupportedError('background');
  }

  async rename(): Promise<void> {
    // GAP: `codex exec` has no rename verb, and the thread title lives only in
    // the state DB's `threads.title` column — editing it would be a WRITE to a
    // foreign SQLite DB, which this adapter forbids. So rename is unsupported.
    throw new AdapterUnsupportedError('rename');
  }

  detectPromptState(screen: string): PromptState {
    if (APPROVAL_RE.test(screen)) {
      const options: MenuOption[] = [
        { index: 0, label: 'Yes', value: 'y' },
        { index: 1, label: 'No', value: 'n' },
      ];
      return { kind: 'menu', menuType: 'permission', options };
    }
    if (BUSY_RE.test(screen)) return { kind: 'busy' };
    // Honest default: Codex's idle prompt is not reliably classifiable here.
    return { kind: 'unknown' };
  }
}

// ---------------------------------------------------------------------------
// (a) Headless exec-json runner
// ---------------------------------------------------------------------------

/** One decoded event from the `codex exec --json` JSONL stream. */
export interface CodexExecEvent {
  [k: string]: unknown;
}

/** Options for a headless Codex turn. */
export interface CodexHeadlessOptions {
  /** The directive/prompt to send. */
  prompt: string;
  /** Working directory for the turn (`-C`). */
  cwd?: string;
  /** Resume an existing session by id (`codex exec resume <id>`). */
  resumeId?: string;
  /** Model override (`-m`). */
  model?: string;
  /** Sandbox policy (`-s`), e.g. `read-only`. */
  sandbox?: string;
  /** Approval policy override, e.g. `never` (emitted as `-c approval_policy=…`). */
  approval?: string;
  /** Skip Codex's "trusted directory / git repo" guard (`--skip-git-repo-check`). */
  skipGitRepoCheck?: boolean;
  /** Abort signal to kill the child. */
  signal?: AbortSignal;
  /** Per-turn timeout (ms). Default 120_000. */
  timeoutMs?: number;
}

/** The result of a headless Codex turn. */
export interface CodexHeadlessResult {
  /** Process exit code (null when killed by signal). */
  exitCode: number | null;
  /** Every JSONL event parsed off stdout, in order. */
  events: CodexExecEvent[];
  /** The final agent message text, when one was emitted. */
  finalMessage?: string;
  /** True when at least one well-formed JSON event was seen. */
  sawJson: boolean;
  /** Raw stderr (bounded), surfaced for diagnostics. */
  stderr: string;
}

/** A spawn function, injected so tests never shell out. */
export type SpawnFn = (cmd: string, args: string[], cwd: string | undefined) => ChildProcess;

const defaultSpawn: SpawnFn = (cmd, args, cwd) =>
  spawn(cmd, args, {
    ...(cwd ? { cwd } : {}),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

/**
 * Build the `codex exec` argv for a headless turn. `--json` is always present;
 * a `resumeId` switches to the `exec resume <id>` subcommand. The prompt is the
 * trailing positional.
 */
export function buildExecArgs(opts: CodexHeadlessOptions): string[] {
  const args: string[] = opts.resumeId ? ['exec', 'resume', opts.resumeId] : ['exec'];
  args.push('--json');
  if (opts.cwd) args.push('-C', opts.cwd);
  if (opts.model) args.push('-m', opts.model);
  if (opts.sandbox) args.push('-s', opts.sandbox);
  // `codex exec` has no `-a/--ask-for-approval` flag (that is a root-level flag);
  // the approval policy is set via the global `-c key=value` config override.
  if (opts.approval) args.push('-c', `approval_policy=${opts.approval}`);
  if (opts.skipGitRepoCheck) args.push('--skip-git-repo-check');
  args.push(opts.prompt);
  return args;
}

/**
 * Extract the final agent message text from a decoded event, if it carries one.
 * `codex exec --json` uses an item-based schema
 * (`{type:'item.completed', item:{type:'agent_message', text}}`), verified live
 * on codex-cli 0.142.5; the rollout-style `agent_message`/`message` forms are
 * also handled so the same extractor serves both streams.
 */
function agentMessageOf(ev: CodexExecEvent): string | undefined {
  // exec --json item schema.
  if (ev['type'] === 'item.completed') {
    const item = ev['item'];
    if (item && typeof item === 'object') {
      const it = item as Record<string, unknown>;
      if (it['type'] === 'agent_message' && typeof it['text'] === 'string') {
        return it['text'] as string;
      }
    }
  }
  const payload = (ev['payload'] ?? ev['msg'] ?? ev) as Record<string, unknown> | undefined;
  if (!payload || typeof payload !== 'object') return undefined;
  const type = payload['type'];
  // rollout event_msg agent_message.
  if (type === 'agent_message' && typeof payload['message'] === 'string') {
    return payload['message'] as string;
  }
  // rollout response_item message with role assistant.
  if (type === 'message' && payload['role'] === 'assistant') {
    const c = payload['content'];
    if (Array.isArray(c)) {
      const txt = c
        .map((b) => (b && typeof b === 'object' ? (b as Record<string, unknown>)['text'] : ''))
        .filter((t): t is string => typeof t === 'string')
        .join('');
      if (txt) return txt;
    }
  }
  return undefined;
}

/**
 * Runs headless Codex turns over `codex exec --json`. The binary and spawn are
 * injectable so unit tests never shell out; the real binary is used only by the
 * env-gated E2E and the panel.
 */
export class CodexHeadlessRunner {
  constructor(
    private readonly bin: string = 'codex',
    private readonly spawnFn: SpawnFn = defaultSpawn,
  ) {}

  /** Run one turn and resolve when the process exits (or the timeout fires). */
  run(opts: CodexHeadlessOptions): Promise<CodexHeadlessResult> {
    const args = buildExecArgs(opts);
    const child = this.spawnFn(this.bin, args, opts.cwd);
    const events: CodexExecEvent[] = [];
    let finalMessage: string | undefined;
    let sawJson = false;
    let stderr = '';
    let stdoutBuf = '';

    const timeoutMs = opts.timeoutMs ?? 120_000;

    return new Promise<CodexHeadlessResult>((resolve) => {
      let settled = false;
      const finish = (exitCode: number | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Flush a trailing partial line if it happens to be complete JSON.
        const tail = stdoutBuf.trim();
        if (tail) {
          try {
            const ev = JSON.parse(tail) as CodexExecEvent;
            sawJson = true;
            events.push(ev);
            finalMessage = agentMessageOf(ev) ?? finalMessage;
          } catch {
            /* genuinely partial — drop */
          }
        }
        resolve({
          exitCode,
          events,
          sawJson,
          stderr: stderr.slice(0, 8192),
          ...(finalMessage !== undefined ? { finalMessage } : {}),
        });
      };

      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        finish(null);
      }, timeoutMs);

      if (opts.signal) {
        opts.signal.addEventListener('abort', () => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* already gone */
          }
          finish(null);
        });
      }

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdoutBuf += chunk;
        let nl: number;
        while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
          const line = stdoutBuf.slice(0, nl);
          stdoutBuf = stdoutBuf.slice(nl + 1);
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const ev = JSON.parse(trimmed) as CodexExecEvent;
            sawJson = true;
            events.push(ev);
            finalMessage = agentMessageOf(ev) ?? finalMessage;
          } catch {
            /* non-JSON log line — ignore */
          }
        }
      });
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        if (stderr.length < 8192) stderr += chunk;
      });
      child.on('error', () => finish(null));
      child.on('close', (code) => finish(code));
    });
  }
}
