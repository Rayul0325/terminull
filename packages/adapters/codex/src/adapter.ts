/**
 * The Codex CLI deep adapter — assembles the honest capability matrix, the
 * index+rollout collector (with SQLite `threads` enrichment), the rollout jsonl
 * parser, the dual-channel driver (headless `codex exec --json` + PTY), the
 * config.toml notify injector, the model registry, the account provider and the
 * harness files into one {@link ToolAdapter}.
 *
 * Like the Claude and generic adapters it is a pure declaration + factories: it
 * never performs core-privileged work, and its driver composes with a
 * caller-supplied injector so this package stays a leaf (no session-host import).
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
import { codexCapabilities, parsePermissionModes } from './capabilities.js';
import { injectDirective } from './app-server-client.js';
import { createCodexCollector } from './collector.js';
import { CodexTranscriptParser } from './parser.js';
import { CodexPtyDriver } from './driver.js';
import { codexKeymap } from './keymap.js';
import { CodexNotifyInjector } from './injector.js';
import { createCodexModelRegistry } from './models.js';
import { createCodexAccountProvider } from './usage.js';
import { codexHarnessFiles } from './harness-files.js';

const pexec = promisify(execFile);

/** Options that make every I/O-touching part injectable for tests. */
export interface CodexAdapterOptions {
  /** Override the `.codex` home used by the collector/models/accounts/injector. */
  codexHome?: string;
  /** Override the state DB path used by the collector. */
  statePath?: string;
  /** Override the `auth.json` path used by accounts. */
  authPath?: string;
  /** Override the `config.toml` path used by models. */
  configPath?: string;
  /** Terminull data dir (profiles registry) used by accounts. */
  dataDir?: string;
  /** Override the source `harness/` dir used by the injector. */
  harnessDir?: string;
  /** Fetch help text for a resolved binary + args (injected in tests). */
  runHelp?: (binPath: string, args: string[]) => Promise<string | null>;
  /** Whether `codex app-server --help` exits 0 for the resolved binary (injected in tests). */
  probeAppServer?: (binPath: string) => Promise<boolean>;
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

/** Default help runner: shell out, bounded, failure → null. */
async function defaultRunHelp(binPath: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await pexec(binPath, args, { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    // `--help` may exit non-zero on some CLIs but still print to stdout.
    const out = (err as { stdout?: string }).stdout;
    return typeof out === 'string' && out.length > 0 ? out : null;
  }
}

/** Default app-server probe: `codex app-server --help` exit 0 ⇒ present. */
async function defaultProbeAppServer(binPath: string): Promise<boolean> {
  try {
    await pexec(binPath, ['app-server', '--help'], { timeout: 5000, maxBuffer: 1024 * 1024 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Create the Codex CLI adapter. All external I/O is injectable via
 * {@link CodexAdapterOptions} so unit tests never touch the real home or shell.
 */
export function createCodexAdapter(opts: CodexAdapterOptions = {}): ToolAdapter {
  const collector = createCodexCollector({
    ...(opts.codexHome ? { codexHome: opts.codexHome } : {}),
    ...(opts.statePath ? { statePath: opts.statePath } : {}),
  });
  const parser = new CodexTranscriptParser();
  const models = createCodexModelRegistry({
    ...(opts.codexHome ? { codexHome: opts.codexHome } : {}),
    ...(opts.configPath ? { configPath: opts.configPath } : {}),
  });
  const accounts = createCodexAccountProvider({
    ...(opts.codexHome ? { codexHome: opts.codexHome } : {}),
    ...(opts.authPath ? { authPath: opts.authPath } : {}),
    ...(opts.dataDir ? { dataDir: opts.dataDir } : {}),
  });
  const injector = new CodexNotifyInjector({
    ...(opts.codexHome ? { codexHome: opts.codexHome } : {}),
    ...(opts.harnessDir ? { harnessDir: opts.harnessDir } : {}),
  });

  return {
    id: 'codex',
    displayName: { en: 'Codex', ko: 'Codex' },
    capabilities: codexCapabilities(),

    async probe(ctx: ProbeContext): Promise<ProbeResult> {
      const cmd = ctx.cmd ?? 'codex';
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
      const probeAppServer = opts.probeAppServer ?? defaultProbeAppServer;

      // Permission modes: parse the sandbox + approval tokens out of the live
      // help (both `codex --help` and `codex exec --help` carry them).
      const [rootHelp, execHelp, appServer] = await Promise.all([
        runHelp(resolved, ['--help']),
        runHelp(resolved, ['exec', '--help']),
        probeAppServer(resolved),
      ]);
      const perms = parsePermissionModes(`${rootHelp ?? ''}\n${execHelp ?? ''}`);

      // coDrive is upgraded to 'app-server' ONLY when the subcommand is present.
      const coDrive = appServer ? ('app-server' as const) : ('none' as const);
      return {
        present: true,
        capabilities: { permissionModes: perms.modes, coDrive },
        detail: {
          en: `Found Codex; permission modes from ${perms.source}: ${perms.modes.join(', ')}; app-server: ${appServer ? 'present' : 'absent'}`,
          ko: `Codex 발견; 권한 모드 출처 ${perms.source}: ${perms.modes.join(', ')}; app-server: ${appServer ? '있음' : '없음'}`,
        },
      };
    },

    collector,
    parser,

    driverFor(_session: DiscoveredSession, ctx: DriveContext): Driver {
      return new CodexPtyDriver(codexKeymap, ctx.inject);
    },

    keymap: codexKeymap,
    injector,
    models,
    accounts,
    harnessFiles: codexHarnessFiles,
    // M9 profiles: CODEX_HOME relocates the whole ~/.codex config home — the
    // documented isolation seam; set per spawn, never bridged.
    configHomeEnvVars: ['CODEX_HOME'],

    // Codex has no pid registry, so a discovered session can't be resolved to a
    // tmux pane. But the app-server keys on the same id we display: the session
    // id IS the rollout uuid IS the app-server threadId. So deliver by that id
    // via `turn/start` — no pane/pid join. Failure isolates to 'unsupported'.
    deliverDirectiveToDiscovered: (session, text) => injectDirective(session.id, text),
  };
}

/** Default export = the adapter factory (plugin-contract entry point). */
export default createCodexAdapter;
