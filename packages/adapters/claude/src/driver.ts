/**
 * The Claude Code PTY driver.
 *
 * Composes with a caller-supplied {@link KeyInjector} (the session-host IN
 * channel) exactly like the generic adapter — this package never imports the
 * session-host. Everything tool-specific lives here:
 *  - a quirk engine that primes ShiftTab with a `Right` + ~120 ms (Claude drops
 *    the first key after the pane goes idle);
 *  - `sendText` that clears the input draft (CtrlU) before typing so a directive
 *    is never glued onto leftover text;
 *  - a SAFE `answerMenu` that verifies a menu is on screen BEFORE any keystroke,
 *    walks the cursor by option position, and (optionally) post-verifies the
 *    menu is gone;
 *  - `detectPromptState` that is HONESTLY `unknown` when it cannot classify.
 */
import {
  MenuNotPresentError,
  UnknownKeyError,
  AdapterUnsupportedError,
  type AnswerMenuOptions,
  type Driver,
  type Keymap,
  type KeyInjector,
  type MenuOption,
  type MenuType,
  type NamedKey,
  type PromptState,
  type SendTextOptions,
} from '@terminull/adapter-sdk';
import { RIGHT_BYTES, SHIFTTAB_PRIME_DELAY_MS } from './keymap.js';

const encoder = new TextEncoder();

/** Keys that must be primed with a `Right` (Claude drops the first post-idle key). */
const PRIME_KEYS = new Set<NamedKey>(['ShiftTab']);

/**
 * The permission modes reachable by the Shift+Tab cycle, in order.
 *
 * Empirically verified live against 2.1.201 (see `test/shifttab-probe.test.ts`):
 * the TUI cycles `default → acceptEdits → plan → bypassPermissions → auto →`
 * (wrap). Footer badges observed: "auto mode on", "accept edits on", "plan mode
 * on", "bypass permissions on", and an empty footer for `default`. This is FIVE
 * modes — `bypassPermissions` and the new `auto` mode are now IN the cycle (an
 * older survey assumed bypass was launch-only). `manual` and `dontAsk` are
 * `--permission-mode` launch choices only and are NOT reachable via Shift+Tab.
 */
export const SHIFT_TAB_CYCLE: readonly string[] = [
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
  'auto',
];

/** A screen snapshot source used for post-verification. */
export type SnapshotFn = () => string | Promise<string>;

/** {@link AnswerMenuOptions} plus an optional post-verify snapshot callback. */
export interface ClaudeAnswerMenuOptions extends AnswerMenuOptions {
  /** Called after keystrokes to confirm the menu is gone; throws if it isn't. */
  snapshot?: SnapshotFn;
}

/** Options for {@link ClaudeDriver}. */
export interface ClaudeDriverOptions {
  /** Delay implementation (injectable so tests assert byte order deterministically). */
  sleep?: (ms: number) => Promise<void>;
  /** Whether `/rename` is offered (capability-flagged). Default true. */
  supportsRename?: boolean;
  /** Permission-mode cycle order (defaults to {@link SHIFT_TAB_CYCLE}). */
  shiftTabCycle?: readonly string[];
}

/** Thrown by `answerMenu` when the menu is still present after answering. */
export class MenuNotDismissedError extends Error {
  readonly code = 'MENU_NOT_DISMISSED';
  constructor(readonly observed: PromptState['kind']) {
    super(`menu still present after answering (observed '${observed}')`);
    this.name = 'MenuNotDismissedError';
  }
}

// ---------------------------------------------------------------------------
// Pure screen parsing (exported for tests)
// ---------------------------------------------------------------------------

/** One menu line matched on screen: printed number, label, and cursor state. */
const OPTION_RE = /^\s*(❯|›|»|▶|\*)?\s*(?:\[[ xX]\]\s*)?(\d+)[.)]\s+(.+?)\s*$/;

interface ParsedMenu {
  options: MenuOption[];
  /** Index (0-based, by appearance) of the option under the ❯ cursor. */
  cursorIndex: number;
}

/** Parse numbered menu options from a screen tail (pure). */
export function parseMenu(screen: string): ParsedMenu {
  const options: MenuOption[] = [];
  let cursorIndex = 0;
  for (const line of screen.split('\n')) {
    const m = OPTION_RE.exec(line);
    if (!m) continue;
    const marker = m[1];
    const label = (m[3] ?? '').trim();
    if (!label) continue;
    const index = options.length;
    const selected = marker === '❯' || marker === '›' || marker === '»' || marker === '▶';
    if (selected) cursorIndex = index;
    options.push({ index, label, ...(selected ? { selected: true } : {}) });
  }
  return { options, cursorIndex };
}

function isBusy(screen: string): boolean {
  // The definitive marker Claude prints while generating; braille spinner is a
  // secondary signal. Both are reliable on the live tail.
  return /esc to (interrupt|stop)/i.test(screen) || /[⠀-⣿]\s*\S/.test(screen);
}

function isIdle(screen: string): boolean {
  // Claude's ready prompt shows the `❯` input box and a `shift+tab to cycle`
  // footer (verified against the live TUI); `? for shortcuts` / a bare `>` box
  // are older/alternate forms. Checked AFTER busy + menu, so a `❯` here is the
  // input prompt, never a menu cursor (numbered menus are caught first).
  return (
    /shift\s*\+\s*tab to cycle/i.test(screen) ||
    /\?\s*for shortcuts/i.test(screen) ||
    /❯\s/.test(screen) ||
    /│\s+>\s/.test(screen) ||
    /(^|\n)\s*>\s*$/.test(screen)
  );
}

function menuTypeOf(screen: string): MenuType {
  return /plan|proceed|keep planning|approve/i.test(screen) ? 'plan' : 'select';
}

function isMultiSelect(screen: string): boolean {
  return /\[[ xX]\]/.test(screen) || /space to (select|toggle)/i.test(screen);
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

/** Drives a live Claude Code session over the injected IN channel. */
export class ClaudeDriver implements Driver {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly supportsRename: boolean;
  private readonly cycle: readonly string[];

  constructor(
    private readonly keymap: Keymap,
    private readonly inject: KeyInjector,
    opts: ClaudeDriverOptions = {},
  ) {
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.supportsRename = opts.supportsRename ?? true;
    this.cycle = opts.shiftTabCycle ?? SHIFT_TAB_CYCLE;
  }

  private bytesFor(key: NamedKey): Uint8Array {
    const binding = this.keymap[key];
    if (!binding) throw new UnknownKeyError(key);
    return binding.bytes;
  }

  async sendText(opts: SendTextOptions): Promise<void> {
    // Draft-clear FIRST so the text is never glued onto a half-typed draft.
    await this.inject(this.bytesFor('CtrlU'));
    await this.inject(encoder.encode(opts.text));
    // Claude directives submit by default; opts.submit === false skips Enter.
    if (opts.submit !== false) await this.inject(this.bytesFor('Enter'));
  }

  async sendKey(key: NamedKey): Promise<void> {
    const bytes = this.bytesFor(key); // throws UnknownKeyError before any prime
    if (PRIME_KEYS.has(key)) {
      await this.inject(RIGHT_BYTES);
      await this.sleep(SHIFTTAB_PRIME_DELAY_MS);
    }
    await this.inject(bytes);
  }

  /** Walk the cursor from `from` to `to` with Up/Down, no priming (menu is live). */
  private async walk(from: number, to: number): Promise<void> {
    const delta = to - from;
    const key: NamedKey = delta >= 0 ? 'Down' : 'Up';
    const bytes = this.bytesFor(key);
    for (let i = 0; i < Math.abs(delta); i++) await this.inject(bytes);
  }

  async answerMenu(opts: ClaudeAnswerMenuOptions): Promise<void> {
    const state = this.detectPromptState(opts.screen);
    if (state.kind !== 'menu') throw new MenuNotPresentError(state.kind);
    const { options, cursorIndex } = parseMenu(opts.screen);
    const choices = Array.isArray(opts.choice) ? opts.choice : [opts.choice];
    for (const c of choices) {
      if (c < 0 || c >= options.length) {
        throw new RangeError(`choice ${c} out of range (${options.length} options)`);
      }
    }

    if (opts.multiSelect) {
      // Toggle each target with Space, moving the cursor between them.
      let pos = cursorIndex;
      for (const c of choices) {
        await this.walk(pos, c);
        await this.inject(this.bytesFor('Space'));
        pos = c;
      }
      await this.inject(this.bytesFor('Enter'));
    } else {
      await this.walk(cursorIndex, choices[0] ?? cursorIndex);
      await this.inject(this.bytesFor('Enter'));
    }

    // Post-verify: confirm the menu is gone (best-effort — only if a snapshot
    // source was provided). An un-dismissed menu is a loud, typed failure.
    if (opts.snapshot) {
      const after = await opts.snapshot();
      const post = this.detectPromptState(after);
      if (post.kind === 'menu') throw new MenuNotDismissedError(post.kind);
    }
  }

  async approvePlan(screen: string): Promise<void> {
    const state = this.detectPromptState(screen);
    if (state.kind !== 'menu') throw new MenuNotPresentError(state.kind);
    // Approve = the first option (Claude lists "Yes …" first); walk + Enter.
    const { cursorIndex } = parseMenu(screen);
    await this.walk(cursorIndex, 0);
    await this.inject(this.bytesFor('Enter'));
  }

  async setPermissionMode(mode: string, screen: string): Promise<void> {
    const targetIdx = this.cycle.indexOf(mode);
    if (targetIdx < 0) {
      throw new AdapterUnsupportedError(
        `setPermissionMode('${mode}') — only ${this.cycle.join('/')} are reachable via Shift+Tab; ` +
          `manual/dontAsk are set at launch (--permission-mode)`,
      );
    }
    const currentIdx = this.detectPermissionMode(screen);
    const steps = (targetIdx - currentIdx + this.cycle.length) % this.cycle.length;
    for (let i = 0; i < steps; i++) await this.sendKey('ShiftTab');
  }

  /**
   * Best-effort current permission mode as an index into the cycle. Matches the
   * footer badges 2.1.201 prints (probe-verified): "bypass permissions on",
   * "plan mode on", "accept edits on", "auto mode on"; anything else = default.
   * `bypass` is checked before `auto`/`edits` since its badge is unambiguous.
   */
  private detectPermissionMode(screen: string): number {
    if (/bypass permissions/i.test(screen)) return this.cycle.indexOf('bypassPermissions');
    if (/plan mode/i.test(screen)) return this.cycle.indexOf('plan');
    if (/accept edits/i.test(screen)) return this.cycle.indexOf('acceptEdits');
    if (/auto mode/i.test(screen)) return this.cycle.indexOf('auto');
    return this.cycle.indexOf('default'); // -1 if 'default' not in a custom cycle
  }

  async interrupt(): Promise<void> {
    // Claude stops the current turn on Escape (not Ctrl+C, which quits the TUI).
    await this.inject(this.bytesFor('Escape'));
  }

  async background(): Promise<void> {
    await this.inject(this.bytesFor('CtrlB'));
  }

  async rename(title: string): Promise<void> {
    if (!this.supportsRename) throw new AdapterUnsupportedError('rename');
    await this.sendText({ text: `/rename ${title}`, submit: true });
  }

  detectPromptState(screen: string): PromptState {
    if (isBusy(screen)) return { kind: 'busy' };
    const menu = parseMenu(screen);
    if (menu.options.length >= 2) {
      const multiSelect = isMultiSelect(screen);
      return {
        kind: 'menu',
        menuType: menuTypeOf(screen),
        options: menu.options,
        ...(multiSelect ? { multiSelect: true } : {}),
      };
    }
    if (isIdle(screen)) return { kind: 'idle' };
    return { kind: 'unknown' }; // honest: cannot classify
  }
}
