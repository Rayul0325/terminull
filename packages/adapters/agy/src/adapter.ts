/**
 * The Antigravity (`agy`) adapter — assembles the honest "minimal-plus"
 * capability matrix, the mtime-heuristic conversation collector, the PTY
 * fallback driver + keymap, the (config-only) model registry, the Google-account
 * provider and the harness files into one {@link ToolAdapter}.
 *
 * Deliberately has NO transcript parser (agy transcripts are opaque protobuf)
 * and NO harness injector (agy exposes no hooks). Like every adapter it is a
 * pure declaration + factories: it never performs core-privileged work, and its
 * driver composes with a caller-supplied injector so this package stays a leaf
 * (no session-host import).
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  type DiscoveredSession,
  type Driver,
  type DriveContext,
  type ProbeContext,
  type ProbeResult,
  type ToolAdapter,
} from '@terminull/adapter-sdk';
import { agyCapabilities, parsePermissionModes } from './capabilities.js';
import { createAgyCollector } from './collector.js';
import { AgyPtyDriver } from './driver.js';
import { agyKeymap } from './keymap.js';
import { createAgyModelRegistry } from './models.js';
import { createAgyAccountProvider } from './accounts.js';
import { agyHarnessFiles } from './harness-files.js';

const pexec = promisify(execFile);

/** Options that make every I/O-touching part injectable for tests. */
export interface AgyAdapterOptions {
  /** Override the `.gemini` home used by collector/models/accounts/harness files. */
  geminiHome?: string;
  /** Override the `google_accounts.json` path used by accounts. */
  googleAccountsPath?: string;
  /** Override the settings file the model registry reads a configured model from. */
  settingsPath?: string;
  /** Liveness window (ms) for the mtime heuristic. */
  liveWindowMs?: number;
  /** Fetch `agy --help` text for a resolved binary (injected in tests). */
  runHelp?: (binPath: string) => Promise<string | null>;
  /** Fetch `agy --version` text for a resolved binary (injected in tests). */
  runVersion?: (binPath: string) => Promise<string | null>;
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
  if (cmd.includes('/') || cmd.includes(path.sep)) return isExecutable(cmd) ? cmd : null;
  const pathVar = process.env['PATH'] ?? '';
  for (const dir of pathVar.split(path.delimiter)) {
    if (dir.length === 0) continue;
    const full = path.join(dir, cmd);
    if (isExecutable(full)) return full;
  }
  return null;
}

/**
 * Default `agy --help` runner. agy (a Go CLI) prints its usage to STDERR at
 * exit 0, so BOTH streams are concatenated. Bounded; any failure → null. This
 * shells out with no arguments beyond `--help` and makes NO network call.
 */
async function defaultRunHelp(binPath: string): Promise<string | null> {
  try {
    const { stdout, stderr } = await pexec(binPath, ['--help'], {
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const text = `${stdout ?? ''}${stderr ?? ''}`;
    return text.length > 0 ? text : null;
  } catch (err) {
    // Non-zero exit still carries captured output on the error object.
    const e = err as { stdout?: string; stderr?: string };
    const text = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    return text.length > 0 ? text : null;
  }
}

/**
 * Default `agy --version` runner. Prints to stdout at exit 0; bounded, offline,
 * any failure → null.
 */
async function defaultRunVersion(binPath: string): Promise<string | null> {
  try {
    const { stdout, stderr } = await pexec(binPath, ['--version'], {
      timeout: 5000,
      maxBuffer: 256 * 1024,
    });
    const text = `${stdout ?? ''}${stderr ?? ''}`.trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/**
 * Create the Antigravity (`agy`) adapter. All external I/O is injectable via
 * {@link AgyAdapterOptions} so unit tests never touch the real home or shell.
 */
export function createAgyAdapter(opts: AgyAdapterOptions = {}): ToolAdapter {
  const collector = createAgyCollector({
    ...(opts.geminiHome ? { geminiHome: opts.geminiHome } : {}),
    ...(opts.liveWindowMs !== undefined ? { liveWindowMs: opts.liveWindowMs } : {}),
  });
  const models = createAgyModelRegistry({
    ...(opts.geminiHome ? { geminiHome: opts.geminiHome } : {}),
    ...(opts.settingsPath ? { settingsPath: opts.settingsPath } : {}),
  });
  const accounts = createAgyAccountProvider({
    ...(opts.geminiHome ? { geminiHome: opts.geminiHome } : {}),
    ...(opts.googleAccountsPath ? { googleAccountsPath: opts.googleAccountsPath } : {}),
  });

  return {
    id: 'agy',
    displayName: { en: 'Antigravity (agy)', ko: 'Antigravity (agy)' },
    capabilities: agyCapabilities(),

    async probe(ctx: ProbeContext): Promise<ProbeResult> {
      const cmd = ctx.cmd ?? 'agy';
      const resolver = ctx.which ?? defaultWhich;
      const resolved = await resolver(cmd);
      const present = resolved !== null && resolved !== undefined;
      if (!present) {
        return {
          present: false,
          capabilities: {},
          detail: {
            en: `'${cmd}' not found on PATH`,
            ko: `PATH에서 '${cmd}'을(를) 찾지 못했습니다`,
          },
        };
      }
      const runHelp = opts.runHelp ?? defaultRunHelp;
      const runVersion = opts.runVersion ?? defaultRunVersion;
      // Verify permission modes against the live CLI's help (flags), and capture
      // the version. Both are offline (no `agy models`, no network).
      const [help, version] = await Promise.all([runHelp(resolved), runVersion(resolved)]);
      const perms = parsePermissionModes(help);
      return {
        present: true,
        ...(version ? { version } : {}),
        capabilities: { permissionModes: perms.modes },
        detail: {
          en: `Found agy${version ? ` ${version}` : ''}; permission modes from ${perms.source}: ${perms.modes.join(', ')}`,
          ko: `agy 발견${version ? ` ${version}` : ''}; 권한 모드 출처 ${perms.source}: ${perms.modes.join(', ')}`,
        },
      };
    },

    collector,
    // No parser: agy transcripts are opaque protobuf (transcript: 'opaque').

    driverFor(_session: DiscoveredSession, ctx: DriveContext): Driver {
      return new AgyPtyDriver(agyKeymap, ctx.inject);
    },

    keymap: agyKeymap,
    // No injector: agy exposes no hooks (hooks: 'none').
    models,
    accounts,
    harnessFiles: agyHarnessFiles,
  };
}

/** Default export = the adapter factory (plugin-contract entry point). */
export default createAgyAdapter;
