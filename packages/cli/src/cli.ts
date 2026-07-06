/**
 * CLI argv surface — `enroll`, `enroll --remove`, `machines [status]`.
 * Hand-rolled on node:util parseArgs (zero new dependencies, contract §6).
 * All effects go through injected deps so tests never touch a real ssh, a
 * real server, or a real home directory.
 */
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { buildSessionHostBundle } from './bundle.js';
import { AGENT_DIR } from './enroll-manifest.js';
import { EnrollError, enroll, removeEnrollment, type EnrollDeps } from './enroll.js';
import { t, usageText } from './messages.js';
import { RealSshRunner } from './ssh-runner.js';
import { machinesStatus, renderStatusLines } from './status.js';
import { MACHINES_FILE } from '@terminull/shared';

/** Injectable side-effect surface for {@link runCli}. */
export interface CliDeps {
  enrollDeps: EnrollDeps;
  fetchImpl: typeof fetch;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  /** Default server state dir when `--server-state` is not passed. */
  defaultServerState: string;
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
  remove: { type: 'boolean' },
  help: { type: 'boolean' },
} as const;

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
