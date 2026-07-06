/**
 * The Antigravity (`agy`) driver — two delivery paths, both honest about what
 * agy actually supports.
 *
 * (a) HEADLESS one-shot ({@link buildAgyOneshotCommand}): the primary directive
 *     path. agy delivers a turn non-interactively with
 *     `agy -p <text> [--conversation <id>] [--print-timeout <dur>] [--model <m>]`
 *     and prints the response. Resuming a specific conversation is what makes
 *     this a *directive to an existing session* rather than a fresh chat.
 *
 * (b) PTY fallback ({@link AgyPtyDriver}): for an interactive agy TUI attached to
 *     a live pane. It mirrors the generic driver exactly — raw keystrokes via a
 *     caller-supplied injector — because agy's screen has NO adapter-parseable
 *     prompt structure. Therefore {@link AgyPtyDriver.detectPromptState} is
 *     ALWAYS `unknown` (honest), `answerMenu` refuses (never fires blind keys),
 *     and `approvePlan` / `setPermissionMode` / `background` / `rename` throw a
 *     typed {@link AdapterUnsupportedError}.
 *
 * Like every adapter this package stays a leaf: the driver takes an inject
 * function; it never imports the session-host.
 */
import {
  AdapterUnsupportedError,
  MenuNotPresentError,
  UnknownKeyError,
  type AnswerMenuOptions,
  type Driver,
  type Keymap,
  type KeyInjector,
  type NamedKey,
  type PromptState,
  type SendTextOptions,
} from '@terminull/adapter-sdk';

const ENTER_BYTES = Uint8Array.from([0x0d]);
const CTRLC_BYTES = Uint8Array.from([0x03]);
const encoder = new TextEncoder();

// ---------------------------------------------------------------------------
// (a) Headless one-shot command assembly (pure)
// ---------------------------------------------------------------------------

/** Inputs for {@link buildAgyOneshotCommand}. */
export interface AgyOneshotOptions {
  /** The prompt / directive text to deliver. */
  text: string;
  /** Resume + target a specific conversation (`--conversation <id>`). */
  conversationId?: string;
  /** Print-mode wait timeout, e.g. `'30s'` / `'5m'` (`--print-timeout <dur>`). */
  printTimeout?: string;
  /** Model override for this turn (`--model <id>`). */
  model?: string;
  /** Binary to invoke (defaults to `'agy'`). */
  cmd?: string;
  /** Extra args appended verbatim after the standard ones. */
  extraArgs?: readonly string[];
}

/** A resolved command: binary + argv, ready for a child-process spawn. */
export interface AgyOneshotCommand {
  cmd: string;
  args: string[];
}

/**
 * Assemble the argv for a headless agy one-shot turn. The order is stable and
 * `text` is passed as a single argv element (never shell-interpolated), so a
 * prompt containing spaces/quotes is delivered intact.
 *
 * IMPORTANT (verified 2026-07-06 against agy 1.0.16): the caller MUST spawn this
 * with stdin DETACHED — `stdio: ['ignore', …]` or `< /dev/null`. Even in `-p`
 * print mode with the prompt supplied as an argv element, agy blocks reading
 * stdin if it is left open, and `--print-timeout` does NOT bound that wait; with
 * stdin detached the same command returns the response and exits 0 promptly.
 */
export function buildAgyOneshotCommand(opts: AgyOneshotOptions): AgyOneshotCommand {
  const args: string[] = ['-p', opts.text];
  if (opts.conversationId) args.push('--conversation', opts.conversationId);
  if (opts.printTimeout) args.push('--print-timeout', opts.printTimeout);
  if (opts.model) args.push('--model', opts.model);
  if (opts.extraArgs && opts.extraArgs.length > 0) args.push(...opts.extraArgs);
  return { cmd: opts.cmd ?? 'agy', args };
}

// ---------------------------------------------------------------------------
// (b) PTY fallback driver
// ---------------------------------------------------------------------------

/** Drives an interactive agy PTY session with raw keystrokes via the injector. */
export class AgyPtyDriver implements Driver {
  constructor(
    private readonly keymap: Keymap,
    private readonly inject: KeyInjector,
  ) {}

  async sendText(opts: SendTextOptions): Promise<void> {
    await this.inject(encoder.encode(opts.text));
    if (opts.submit) {
      const enter = this.keymap.Enter;
      await this.inject(enter ? enter.bytes : ENTER_BYTES);
    }
  }

  async sendKey(key: NamedKey): Promise<void> {
    const binding = this.keymap[key];
    if (!binding) throw new UnknownKeyError(key);
    await this.inject(binding.bytes);
  }

  async answerMenu(opts: AnswerMenuOptions): Promise<void> {
    // agy's screen can never be classified as a menu, so we refuse rather than
    // fire blind keystrokes. detectPromptState is always 'unknown' → this throws.
    const state = this.detectPromptState(opts.screen);
    if (state.kind !== 'menu') throw new MenuNotPresentError(state.kind);
    // Unreachable for agy; a screen-parsing adapter would navigate + submit here.
    throw new AdapterUnsupportedError('answerMenu');
  }

  async approvePlan(): Promise<void> {
    throw new AdapterUnsupportedError('approvePlan');
  }

  async setPermissionMode(): Promise<void> {
    // Permission mode is chosen at launch (--dangerously-skip-permissions /
    // --sandbox), not toggled inside a running TUI. Honest typed refusal.
    throw new AdapterUnsupportedError('setPermissionMode');
  }

  async interrupt(): Promise<void> {
    const binding = this.keymap.CtrlC;
    await this.inject(binding ? binding.bytes : CTRLC_BYTES);
  }

  async background(): Promise<void> {
    throw new AdapterUnsupportedError('background');
  }

  async rename(): Promise<void> {
    throw new AdapterUnsupportedError('rename');
  }

  detectPromptState(screen: string): PromptState {
    // Honest: agy's screen cannot be classified. `screen` is part of the
    // contract but intentionally unused here.
    void screen;
    return { kind: 'unknown' };
  }
}
