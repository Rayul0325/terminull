/**
 * The generic PTY adapter — Terminull's first dogfooded plugin and the fallback
 * for any CLI tool without a dedicated integration.
 *
 * It claims nothing it cannot back (all capabilities minimal, prompt state
 * always `unknown`, sessions non-discoverable) and drives a session purely
 * through raw PTY keystrokes composed with a caller-supplied injector. The SDK
 * never imports the session-host: the driver takes an inject function, so this
 * package stays a leaf.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  AdapterUnsupportedError,
  MenuNotPresentError,
  UnknownKeyError,
  minimalCapabilities,
} from '@terminull/adapter-sdk';
import type {
  AnswerMenuOptions,
  DiscoveredSession,
  Driver,
  DriveContext,
  Keymap,
  KeyInjector,
  NamedKey,
  ProbeContext,
  ProbeResult,
  PromptState,
  SendTextOptions,
  ToolAdapter,
} from '@terminull/adapter-sdk';
import { genericKeymap } from './keymap.js';

const ENTER_BYTES = Uint8Array.from([0x0d]);
const encoder = new TextEncoder();

/** Drives a generic PTY session with raw keystrokes via the injected IN channel. */
export class GenericPtyDriver implements Driver {
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
    // Pre-verify: a generic tool's prompt can never be classified as a menu, so
    // we refuse rather than fire blind keystrokes.
    const state = this.detectPromptState(opts.screen);
    if (state.kind !== 'menu') throw new MenuNotPresentError(state.kind);
    // Unreachable for the generic adapter (detectPromptState is always
    // 'unknown'); a tool-specific adapter would navigate + submit here.
    throw new AdapterUnsupportedError('answerMenu');
  }

  // Plan approval / permission modes are meaningless for a generic tool.
  async approvePlan(): Promise<void> {
    throw new AdapterUnsupportedError('approvePlan');
  }

  async setPermissionMode(): Promise<void> {
    throw new AdapterUnsupportedError('setPermissionMode');
  }

  async interrupt(): Promise<void> {
    const binding = this.keymap.CtrlC;
    await this.inject(binding ? binding.bytes : Uint8Array.from([0x03]));
  }

  // A generic PTY tool has no notion of backgrounding or metadata rename.
  async background(): Promise<void> {
    throw new AdapterUnsupportedError('background');
  }

  async rename(): Promise<void> {
    throw new AdapterUnsupportedError('rename');
  }

  detectPromptState(screen: string): PromptState {
    // Honest: a generic tool's screen cannot be classified. `screen` is part of
    // the contract but intentionally unused here.
    void screen;
    return { kind: 'unknown' };
  }
}

function isExecutable(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Default PATH resolver used when {@link ProbeContext.which} is not supplied. */
function defaultWhich(cmd: string): string | null {
  if (cmd.includes('/') || cmd.includes(path.sep)) {
    return isExecutable(cmd) ? cmd : null;
  }
  const pathVar = process.env['PATH'] ?? '';
  for (const dir of pathVar.split(path.delimiter)) {
    if (dir.length === 0) continue;
    const full = path.join(dir, cmd);
    if (isExecutable(full)) return full;
  }
  return null;
}

/**
 * The generic adapter factory (the default export of this module, per the
 * plugin contract). Third-party plugins register the same way.
 */
export function createGenericAdapter(): ToolAdapter {
  return {
    id: 'generic-pty',
    displayName: { en: 'Generic CLI', ko: '일반 CLI' },
    capabilities: minimalCapabilities(),

    async probe(ctx: ProbeContext): Promise<ProbeResult> {
      const cmd = ctx.cmd;
      if (cmd === undefined || cmd.length === 0) {
        return {
          present: false,
          capabilities: {},
          detail: { en: 'No command configured to probe', ko: '탐지할 명령이 설정되지 않았습니다' },
        };
      }
      const resolver = ctx.which ?? defaultWhich;
      const resolved = await resolver(cmd);
      const present = resolved !== null && resolved !== undefined;
      return {
        // Probe verifies presence only; it claims no capabilities (honesty).
        present,
        capabilities: {},
        detail: present
          ? { en: `Found '${cmd}'`, ko: `'${cmd}' 을(를) 찾았습니다` }
          : { en: `'${cmd}' not found on PATH`, ko: `PATH에서 '${cmd}' 을(를) 찾지 못했습니다` },
      };
    },

    collector: {
      // Generic tools are not discoverable: nothing to enumerate.
      collect(): Promise<DiscoveredSession[]> {
        return Promise.resolve([]);
      },
    },

    driverFor(_session: DiscoveredSession, ctx: DriveContext): Driver {
      return new GenericPtyDriver(genericKeymap, ctx.inject);
    },

    keymap: genericKeymap,

    models: {
      // No model discovery for a generic tool.
      list(): Promise<never[]> {
        return Promise.resolve([]);
      },
    },
  };
}

/** Default export = the adapter factory (plugin-contract entry point). */
export default createGenericAdapter;
