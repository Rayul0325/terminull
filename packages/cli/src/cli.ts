/**
 * CLI argv surface — `enroll`, `enroll --remove`, `machines [status]`.
 * Hand-rolled on node:util parseArgs (zero new dependencies, contract §6).
 * All effects go through injected deps so tests never touch a real ssh, a
 * real server, or a real home directory.
 */
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { buildSessionHostBundle } from './bundle.js';
import {
  type SetupDeps,
  type ToolDetection,
  runDoctor,
  runEject,
  runInject,
  runSetup,
  runUninstall,
} from './commands.js';
import { AGENT_DIR } from './enroll-manifest.js';
import { EnrollError, enroll, removeEnrollment, type EnrollDeps } from './enroll.js';
import { t, usageText } from './messages.js';
import { runPluginsAdd, runPluginsScaffold, runPluginsValidate } from './plugins.js';
import { runServe } from './serve.js';
import { type ServiceManager, createServiceManager } from './service.js';
import { RealSshRunner } from './ssh-runner.js';
import { machinesStatus, renderStatusLines } from './status.js';
import { MACHINES_FILE } from '@terminull/shared';

/** CLI product version (published `terminull` package version). */
export const CLI_VERSION = '0.1.0';

/**
 * Injectable side-effect surface for {@link runCli}. The `setup*` fields are
 * OPTIONAL seams: production defaults are filled by {@link resolveSetupDeps},
 * and tests override them to run entirely against fake homes.
 */
export interface CliDeps {
  enrollDeps: EnrollDeps;
  fetchImpl: typeof fetch;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  /** Default server state dir when `--server-state` is not passed. */
  defaultServerState: string;
  /** User home selecting tool homes (default: os.homedir()). */
  home?: string;
  /** Tool detection seam (default: `<bin> --version`). */
  detectTool?: (bin: string) => Promise<ToolDetection>;
  /** Consent prompt seam (default: stdin y/N). */
  prompt?: (question: string) => Promise<boolean>;
  /** Background-service manager (default: platform-appropriate). */
  serviceManager?: ServiceManager;
  /** LaunchAgents dir for the default darwin service manager. */
  launchAgentsDir?: string;
  /** Absolute entry script for the service plist (default: process.argv[1]). */
  entry?: string;
  execFileImpl?: SetupDeps['execFileImpl'];
  now?: () => number;
}

/** Production deps: real ssh, real bundle build, real fetch. */
export function productionCliDeps(): CliDeps {
  const stdout = (line: string): void => void process.stdout.write(`${line}\n`);
  const stderr = (line: string): void => void process.stderr.write(`${line}\n`);
  return {
    enrollDeps: {
      runner: new RealSshRunner(),
      buildBundle: buildSessionHostBundle,
      log: stdout,
    },
    fetchImpl: fetch,
    stdout,
    stderr,
    defaultServerState: path.join(os.homedir(), '.terminull'),
  };
}

const PARSE_OPTIONS = {
  id: { type: 'string' },
  label: { type: 'string' },
  node: { type: 'string' },
  'server-state': { type: 'string' },
  dir: { type: 'string' },
  host: { type: 'string' },
  port: { type: 'string' },
  remove: { type: 'boolean' },
  yes: { type: 'boolean' },
  purge: { type: 'boolean' },
  json: { type: 'boolean' },
  help: { type: 'boolean' },
} as const;

/** Default tool detection: `<bin> --version`; ENOENT ⇒ not present. */
const realDetectTool = (bin: string): Promise<ToolDetection> =>
  new Promise((resolve) => {
    execFile(bin, ['--version'], { timeout: 5_000 }, (err, stdout) => {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        resolve({ present: false });
        return;
      }
      resolve({ present: true, version: String(stdout).trim().split('\n')[0] ?? '?', path: bin });
    });
  });

/** Default consent prompt: one stdin line; y/Y ⇒ true, everything else false. */
const realPrompt = (question: string): Promise<boolean> =>
  new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      resolve(false); // non-interactive without --yes = decline (never assume consent)
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });

/** Fill production defaults for the product-command seams. */
function resolveSetupDeps(serverState: string, deps: CliDeps): SetupDeps {
  const home = deps.home ?? os.homedir();
  const launchAgentsDir = deps.launchAgentsDir ?? path.join(home, 'Library', 'LaunchAgents');
  return {
    home,
    stateDir: serverState,
    stdout: deps.stdout,
    stderr: deps.stderr,
    detectTool: deps.detectTool ?? realDetectTool,
    prompt: deps.prompt ?? realPrompt,
    serviceManager: deps.serviceManager ?? createServiceManager({ launchAgentsDir }),
    nodePath: process.execPath,
    entry: deps.entry ?? process.argv[1] ?? '',
    ...(deps.execFileImpl ? { execFileImpl: deps.execFileImpl } : {}),
    fetchImpl: deps.fetchImpl,
    coreVersion: CLI_VERSION,
    ...(deps.now ? { now: deps.now } : {}),
  };
}

/** Parse + dispatch. Returns the process exit code (0 ok, 1 error, 2 usage). */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  let parsed: ReturnType<
    typeof parseArgs<{ options: typeof PARSE_OPTIONS; allowPositionals: true }>
  >;
  try {
    parsed = parseArgs({ args: argv, options: PARSE_OPTIONS, allowPositionals: true });
  } catch (err) {
    deps.stderr((err as Error).message);
    deps.stderr(usageText());
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    deps.stdout(usageText());
    return 0;
  }
  const serverState = values['server-state'] ?? deps.defaultServerState;
  const command = positionals[0];

  try {
    switch (command) {
      case 'enroll': {
        const target = positionals[1];
        if (!target) {
          deps.stderr(t('error.usage'));
          deps.stderr(usageText());
          return 2;
        }
        if (values.remove) {
          return await runRemove(target, serverState, deps);
        }
        return await runEnroll(target, serverState, values, deps);
      }
      case 'machines': {
        const sub = positionals[1];
        if (sub !== undefined && sub !== 'status') {
          deps.stderr(t('error.usage'));
          deps.stderr(usageText());
          return 2;
        }
        return await runStatus(serverState, deps);
      }
      case 'setup':
        return await runSetup(
          { yes: values.yes, ...(positionals[1] ? { tool: positionals[1] } : {}) },
          resolveSetupDeps(serverState, deps),
        );
      case 'inject':
        return await runInject(
          { yes: values.yes, ...(positionals[1] ? { tool: positionals[1] } : {}) },
          resolveSetupDeps(serverState, deps),
        );
      case 'eject':
        return await runEject(
          { ...(positionals[1] ? { tool: positionals[1] } : {}) },
          resolveSetupDeps(serverState, deps),
        );
      case 'serve':
        return await runServe(
          {
            stateDir: serverState,
            ...(values.host ? { host: values.host } : {}),
            ...(values.port ? { port: Number(values.port) } : {}),
          },
          { stdout: deps.stdout, stderr: deps.stderr },
        );
      case 'doctor':
        return await runDoctor(resolveSetupDeps(serverState, deps));
      case 'uninstall':
        return await runUninstall(
          { purge: values.purge, yes: values.yes },
          resolveSetupDeps(serverState, deps),
        );
      case 'plugins':
        return await runPlugins(positionals.slice(1), serverState, values, deps);
      default: {
        deps.stderr(t('error.usage'));
        deps.stderr(usageText());
        return 2;
      }
    }
  } catch (err) {
    if (err instanceof EnrollError) {
      deps.stderr(`[${err.code}] ${err.message}`);
      return 1;
    }
    deps.stderr((err as Error).message);
    return 1;
  }
}

async function runEnroll(
  host: string,
  serverState: string,
  values: { id?: string; label?: string; node?: string },
  deps: CliDeps,
): Promise<number> {
  const result = await enroll(
    { host, id: values.id, label: values.label, node: values.node, serverState },
    { ...deps.enrollDeps, fetchImpl: deps.fetchImpl, log: deps.enrollDeps.log ?? deps.stdout },
  );
  deps.stdout(t('enroll.registered', { file: path.join(serverState, MACHINES_FILE) }));
  deps.stdout(JSON.stringify(result.machine, null, 2));
  if (result.reloaded) deps.stdout(t('enroll.reloaded'));
  else deps.stdout(t('enroll.reloadHint', { reason: result.reloadReason ?? 'unknown' }));
  deps.stdout(t('enroll.done', { id: result.machine.id, host }));
  return 0;
}

async function runRemove(query: string, serverState: string, deps: CliDeps): Promise<number> {
  const result = await removeEnrollment(
    { query, serverState },
    { ...deps.enrollDeps, fetchImpl: deps.fetchImpl },
  );
  // Proof lines: remote dir state, registry state, reload state — all honest.
  switch (result.remote) {
    case 'removed':
      deps.stdout(t('remove.remoteRemoved', { host: result.host ?? query, dir: AGENT_DIR }));
      break;
    case 'unreachable':
      deps.stdout(t('remove.remoteUnreachable', { host: result.host ?? query, dir: AGENT_DIR }));
      break;
    case 'failed':
      deps.stdout(
        t('remove.remoteFailed', { host: result.host ?? query, detail: result.remoteDetail ?? '' }),
      );
      break;
    case 'skipped':
      break;
  }
  if (result.entryRemoved && result.id) {
    deps.stdout(
      t('remove.entryRemoved', { id: result.id, file: path.join(serverState, MACHINES_FILE) }),
    );
  } else {
    deps.stdout(t('remove.entryMissing', { query }));
  }
  if (result.reloaded) deps.stdout(t('enroll.reloaded'));
  else deps.stdout(t('enroll.reloadHint', { reason: result.reloadReason ?? 'unknown' }));
  // A failed remote rm with a still-present dir is a partial reversal → exit 1.
  return result.remote === 'failed' ? 1 : 0;
}

async function runPlugins(
  args: string[],
  serverState: string,
  values: { json?: boolean; dir?: string },
  deps: CliDeps,
): Promise<number> {
  const io = { stdout: deps.stdout, stderr: deps.stderr };
  switch (args[0]) {
    case 'validate': {
      const dir = args[1];
      if (!dir) {
        deps.stderr(t('error.usage'));
        deps.stderr(usageText());
        return 2;
      }
      return runPluginsValidate(dir, { ...io, ...(values.json ? { json: true } : {}) });
    }
    case 'scaffold': {
      const point = args[1];
      const name = args[2];
      if (!point || !name) {
        deps.stderr(t('error.usage'));
        deps.stderr(usageText());
        return 2;
      }
      return await runPluginsScaffold(point, name, {
        ...io,
        targetDir: values.dir ?? process.cwd(),
      });
    }
    case 'add': {
      const source = args[1];
      if (!source) {
        deps.stderr(t('error.usage'));
        deps.stderr(usageText());
        return 2;
      }
      return await runPluginsAdd(source, {
        ...io,
        stateDir: serverState,
        ...(deps.now ? { now: deps.now } : {}),
      });
    }
    default:
      deps.stderr(t('error.usage'));
      deps.stderr(usageText());
      return 2;
  }
}

async function runStatus(serverState: string, deps: CliDeps): Promise<number> {
  const status = await machinesStatus(serverState, deps.fetchImpl);
  if (status.source === 'server') {
    deps.stdout(t('status.serverLive', { port: status.port }));
  } else if (status.reason === 'server_down') {
    deps.stdout(t('status.serverDown'));
  } else {
    deps.stdout(t('status.serverNoApi', { detail: status.detail ?? status.reason }));
  }
  if (status.machines.length === 0) {
    deps.stdout(t('status.noMachines'));
    return 0;
  }
  for (const line of renderStatusLines(status)) deps.stdout(line);
  return 0;
}
