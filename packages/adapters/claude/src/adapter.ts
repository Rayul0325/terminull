/**
 * The Claude Code deep adapter — assembles the honest capability matrix, the
 * PID-registry collector, the jsonl transcript parser, the PTY driver, the
 * harness injector, the model registry, the account provider and the harness
 * files into one {@link ToolAdapter}.
 *
 * Like the generic adapter it is a pure declaration + factories: it never
 * performs core-privileged work, and its driver composes with a caller-supplied
 * injector so this package stays a leaf (no session-host import).
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  DiscoveredSession,
  Driver,
  DriveContext,
  ProbeContext,
  ProbeResult,
  ToolAdapter,
} from '@terminull/adapter-sdk';
import { claudeCapabilities, parsePermissionModes } from './capabilities.js';
import { createClaudeCollector } from './collector.js';
import { ClaudeTranscriptParser } from './parser.js';
import { ClaudeDriver, type ClaudeDriverOptions } from './driver.js';
import { claudeKeymap } from './keymap.js';
import { ClaudeHarnessInjector } from './injector.js';
import { createClaudeModelRegistry } from './models.js';
import { createClaudeAccountProvider } from './accounts.js';
import { claudeHarnessFiles } from './harness-files.js';

const pexec = promisify(execFile);

/** Options that make every I/O-touching part injectable for tests. */
export interface ClaudeAdapterOptions {
  /** Override the `.claude` home used by the collector/injector/models. */
  claudeHome?: string;
  /** Override the `.claude.json` path used by accounts. */
  claudeJsonPath?: string;
  /** Terminull data dir (profiles registry) used by accounts. */
  dataDir?: string;
  /** Override the source `harness/` dir used by the injector. */
  harnessDir?: string;
  /** Fetch `claude --help` text for a resolved binary (injected in tests). */
  runHelp?: (binPath: string) => Promise<string | null>;
  /** Driver tuning (sleep/rename/cycle). */
  driver?: ClaudeDriverOptions;
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

/** Default `claude --help` runner: shell out, bounded, failure → null. */
async function defaultRunHelp(binPath: string): Promise<string | null> {
  try {
    const { stdout } = await pexec(binPath, ['--help'], {
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return null;
  }
}

/**
 * Create the Claude Code adapter. All external I/O is injectable via
 * {@link ClaudeAdapterOptions} so unit tests never touch the real home or shell.
 */
export function createClaudeAdapter(opts: ClaudeAdapterOptions = {}): ToolAdapter {
  const collector = createClaudeCollector({
    ...(opts.claudeHome ? { claudeHome: opts.claudeHome } : {}),
  });
  const parser = new ClaudeTranscriptParser();
  const models = createClaudeModelRegistry({
    ...(opts.claudeHome ? { claudeHome: opts.claudeHome } : {}),
  });
  const accounts = createClaudeAccountProvider({
    ...(opts.claudeJsonPath ? { claudeJsonPath: opts.claudeJsonPath } : {}),
    ...(opts.dataDir ? { dataDir: opts.dataDir } : {}),
  });
  const injector = new ClaudeHarnessInjector({
    ...(opts.claudeHome ? { claudeHome: opts.claudeHome } : {}),
    ...(opts.harnessDir ? { harnessDir: opts.harnessDir } : {}),
  });

  return {
    id: 'claude',
    displayName: { en: 'Claude Code', ko: 'Claude Code' },
    capabilities: claudeCapabilities(),

    async probe(ctx: ProbeContext): Promise<ProbeResult> {
      const cmd = ctx.cmd ?? 'claude';
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
      // Verify permission modes against the live CLI (parse, don't hardcode).
      const runHelp = opts.runHelp ?? defaultRunHelp;
      const help = await runHelp(resolved);
      const perms = parsePermissionModes(help);
      return {
        present: true,
        capabilities: { permissionModes: perms.modes },
        detail: {
          en: `Found Claude Code; permission modes from ${perms.source}: ${perms.modes.join(', ')}`,
          ko: `Claude Code 발견; 권한 모드 출처 ${perms.source}: ${perms.modes.join(', ')}`,
        },
      };
    },

    collector,
    parser,

    driverFor(_session: DiscoveredSession, ctx: DriveContext): Driver {
      return new ClaudeDriver(claudeKeymap, ctx.inject, opts.driver ?? {});
    },

    keymap: claudeKeymap,
    injector,
    models,
    accounts,
    harnessFiles: claudeHarnessFiles,
  };
}

/** Default export = the adapter factory (plugin-contract entry point). */
export default createClaudeAdapter;
