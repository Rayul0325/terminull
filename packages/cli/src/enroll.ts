/**
 * `terminull enroll` — install the SSH stdio-relay agent on a remote host and
 * register it as a machine; `--remove` is the complete reversal.
 *
 * Every remote byte goes through the {@link SshRunner} seam. The remote
 * footprint is EXACTLY the enroll manifest (`~/.terminull-agent/` only — see
 * enroll-manifest.ts); VERSION is written LAST so its presence == complete
 * install and a re-run is an idempotent in-place upgrade.
 */
import path from 'node:path';
import {
  AGENT_PREAMBLE,
  LOCAL_MACHINE_ID,
  MACHINE_ID_RE,
  MachineConfigSchema,
  type MachineConfig,
} from '@terminull/shared';
import {
  AGENT_DIR,
  AGENT_HOST_DIR,
  AGENT_LAUNCHER,
  HOST_PID_FILE,
  MIN_REMOTE_NODE_MAJOR,
  REMOTE_NODE_CANDIDATES,
} from './enroll-manifest.js';
import { loadMachinesFile, saveMachinesFile } from './machines-file.js';
import { requestReload } from './server-api.js';
import { t } from './messages.js';
import type { SshRunner, SshRunResult } from './ssh-runner.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type EnrollErrorCode =
  | 'ssh_auth_required'
  | 'ssh_unreachable'
  | 'remote_node_missing'
  | 'remote_node_invalid'
  | 'remote_install_failed'
  | 'remote_native_build_failed'
  | 'agent_probe_failed'
  | 'machine_id_invalid'
  | 'machines_file_invalid'
  | 'bundle_failed';

/** Coded, user-renderable enroll failure (message already localized). */
export class EnrollError extends Error {
  constructor(
    readonly code: EnrollErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EnrollError';
  }
}

function tail(res: SshRunResult, n = 400): string {
  return (res.stderr.trim() || res.stdout.trim() || `exit ${res.code}`).slice(-n);
}

// ---------------------------------------------------------------------------
// Step 1 — preflight probe
// ---------------------------------------------------------------------------

/** Exact preflight command (contract §6.1). BatchMode is applied by the runner. */
export const PREFLIGHT_CMD = 'echo TERMINULL-PROBE && uname -sm && echo "$HOME"';

export interface Preflight {
  /** e.g. `Linux x86_64`, `Darwin arm64`. */
  uname: string;
  /** Remote $HOME (absolute). */
  home: string;
}

/** Reach the host, classify auth-vs-unreachable failures honestly. */
export async function preflight(runner: SshRunner, host: string): Promise<Preflight> {
  const res = await runner.run(host, PREFLIGHT_CMD);
  const lines = res.stdout.split('\n').map((l) => l.trim());
  const mark = lines.indexOf('TERMINULL-PROBE');
  if (res.code !== 0 || mark < 0) {
    if (
      /permission denied|too many authentication|host key verification failed/i.test(res.stderr)
    ) {
      throw new EnrollError('ssh_auth_required', t('error.ssh_auth_required', { host }));
    }
    throw new EnrollError(
      'ssh_unreachable',
      t('error.ssh_unreachable', { host, detail: tail(res) }),
    );
  }
  const uname = lines[mark + 1] ?? '';
  const home = lines[mark + 2] ?? '';
  if (!home.startsWith('/')) {
    throw new EnrollError(
      'ssh_unreachable',
      t('error.ssh_unreachable', { host, detail: 'no $HOME in probe output' }),
    );
  }
  return { uname, home };
}

// ---------------------------------------------------------------------------
// Step 2 — remote node resolution (shadow-trap aware)
// ---------------------------------------------------------------------------

/** `node -p` probe printing `vX.Y.Z\n<realpath of the running executable>`. */
export function nodeProbeCmd(candidate: string): string {
  return `${candidate} -p "process.version + '\\n' + require('fs').realpathSync(process.execPath)"`;
}

/** Newest nvm-installed node, if any (manifest covers the fixed paths). */
export const NVM_LATEST_CMD =
  'ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -n 1';

export interface ResolvedNode {
  /** Pinned ABSOLUTE realpath — what goes into `node-path`. */
  nodePath: string;
  /** e.g. `v22.11.0`. */
  version: string;
  /** Set when a PATH-shadowing node was rejected in favour of a newer one. */
  shadow?: { path: string; version: string };
}

interface Probe {
  source: string;
  requestedPath: string;
  version: string;
  realpath: string;
  parsed: [number, number, number];
}

function parseVersion(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function newer(a: [number, number, number], b: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av > bv;
  }
  return false;
}

async function probeNode(
  runner: SshRunner,
  host: string,
  source: string,
  candidatePath: string,
): Promise<Probe | { fail: string }> {
  const res = await runner.run(host, nodeProbeCmd(candidatePath));
  if (res.code !== 0) return { fail: tail(res, 120) };
  const [versionLine = '', realpathLine = ''] = res.stdout.split('\n').map((l) => l.trim());
  const parsed = parseVersion(versionLine);
  if (!parsed || !realpathLine.startsWith('/'))
    return { fail: `unparseable probe: ${versionLine}` };
  return {
    source,
    requestedPath: candidatePath,
    version: versionLine,
    realpath: realpathLine,
    parsed,
  };
}

/**
 * Resolve and pin the remote node per the manifest probe order, then apply the
 * shadow-trap rule: when the PATH `node` lives under `~/.local/bin` and a
 * strictly newer usable node exists at a real install location (homebrew /
 * /usr/local / system / nvm), the newer one wins and the shadow is reported.
 * `--node` (explicit) skips probing order but still enforces >= v22.
 */
export async function resolveRemoteNode(
  runner: SshRunner,
  host: string,
  home: string,
  explicitNode?: string,
): Promise<ResolvedNode> {
  if (explicitNode) {
    const probe = await probeNode(runner, host, 'explicit', explicitNode);
    if ('fail' in probe) {
      throw new EnrollError(
        'remote_node_invalid',
        t('error.remote_node_invalid', {
          path: explicitNode,
          min: MIN_REMOTE_NODE_MAJOR,
          detail: probe.fail,
        }),
      );
    }
    if (probe.parsed[0] < MIN_REMOTE_NODE_MAJOR) {
      throw new EnrollError(
        'remote_node_invalid',
        t('error.remote_node_invalid', {
          path: explicitNode,
          min: MIN_REMOTE_NODE_MAJOR,
          detail: probe.version,
        }),
      );
    }
    return { nodePath: probe.realpath, version: probe.version };
  }

  // Manifest order, with the nvm probe inserted before the ~/.local/bin trap.
  const pathCmd = REMOTE_NODE_CANDIDATES[0]; // 'command -v node'
  const fixed = REMOTE_NODE_CANDIDATES.slice(1, -1);
  const localBin = REMOTE_NODE_CANDIDATES[REMOTE_NODE_CANDIDATES.length - 1]!;
  const steps: Array<{ source: string; locate: () => Promise<string | null> }> = [
    {
      source: 'path',
      locate: async () => {
        const res = await runner.run(host, pathCmd!);
        const found = res.stdout.trim().split('\n')[0]?.trim() ?? '';
        return res.code === 0 && found.startsWith('/') ? found : null;
      },
    },
    ...fixed.map((p) => ({ source: p, locate: () => Promise.resolve<string | null>(p) })),
    {
      source: 'nvm',
      locate: async () => {
        const res = await runner.run(host, NVM_LATEST_CMD);
        const found = res.stdout.trim().split('\n')[0]?.trim() ?? '';
        return res.code === 0 && found.startsWith('/') ? found : null;
      },
    },
    { source: localBin, locate: () => Promise.resolve<string | null>(localBin) },
  ];

  const attempts: string[] = [];
  const inLocalBin = (p: Probe): boolean =>
    p.realpath.startsWith(`${home}/.local/bin/`) ||
    p.requestedPath.startsWith(`${home}/.local/bin/`);

  let winner: Probe | null = null;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const candidate = await step.locate();
    if (!candidate) {
      attempts.push(`${step.source}: not found`);
      continue;
    }
    const probe = await probeNode(runner, host, step.source, candidate);
    if ('fail' in probe) {
      attempts.push(`${candidate}: ${probe.fail}`);
      continue;
    }
    if (probe.parsed[0] < MIN_REMOTE_NODE_MAJOR) {
      attempts.push(`${candidate}: ${probe.version} (< v${MIN_REMOTE_NODE_MAJOR})`);
      continue;
    }
    winner = probe;
    // Shadow trap: a usable PATH node living in ~/.local/bin may hide a newer
    // real install. Probe the remaining locations; a strictly newer usable
    // node displaces the shadow.
    if (step.source === 'path' && inLocalBin(probe)) {
      let best: Probe | null = null;
      for (const rest of steps.slice(i + 1)) {
        const restCandidate = await rest.locate();
        if (!restCandidate) continue;
        const restProbe = await probeNode(runner, host, rest.source, restCandidate);
        if ('fail' in restProbe) continue;
        if (restProbe.parsed[0] < MIN_REMOTE_NODE_MAJOR) continue;
        if (restProbe.realpath === probe.realpath) continue;
        if (!best || newer(restProbe.parsed, best.parsed)) best = restProbe;
      }
      if (best && newer(best.parsed, probe.parsed)) {
        return {
          nodePath: best.realpath,
          version: best.version,
          shadow: { path: probe.realpath, version: probe.version },
        };
      }
    }
    break;
  }

  if (!winner) {
    throw new EnrollError(
      'remote_node_missing',
      t('error.remote_node_missing', {
        host,
        min: MIN_REMOTE_NODE_MAJOR,
        probed: attempts.join('; ') || 'none',
      }),
    );
  }
  return { nodePath: winner.realpath, version: winner.version };
}

// ---------------------------------------------------------------------------
// Steps 3–6 — install + register
// ---------------------------------------------------------------------------

/** Remote install command strings (exported for scripted-runner tests). */
export const INSTALL_CMDS = {
  mkdirs: `mkdir -p ~/${AGENT_DIR}/bin ~/${AGENT_HOST_DIR}`,
  writeNodePath: `cat > ~/${AGENT_DIR}/node-path`,
  extractBundle: `rm -rf ~/${AGENT_DIR}/pkg && mkdir -p ~/${AGENT_DIR}/pkg && tar -xzf - -C ~/${AGENT_DIR}/pkg`,
  // node-pty's darwin prebuilds ship spawn-helper as 0644: require() works but
  // every pty.spawn dies with `posix_spawnp failed` (same trap the workspace
  // postinstall scripts/ensure-node-pty.mjs heals locally). Found live in the
  // M8 e2e — the deployed bundle needs the same healing.
  fixSpawnHelper: `find ~/${AGENT_DIR}/pkg/node_modules -type f -name spawn-helper -exec chmod 755 {} + 2>/dev/null; true`,
  hasNodePty: `test -d ~/${AGENT_DIR}/pkg/node_modules/node-pty`,
  writeLauncher: `cat > ~/${AGENT_LAUNCHER} && chmod 755 ~/${AGENT_LAUNCHER}`,
  probeAgent: `~/${AGENT_LAUNCHER} --probe`,
  writeVersion: `cat > ~/${AGENT_DIR}/VERSION.tmp && mv ~/${AGENT_DIR}/VERSION.tmp ~/${AGENT_DIR}/VERSION`,
} as const;

function checkNodePtyCmd(nodePath: string): string {
  return `cd ~/${AGENT_DIR}/pkg && "${nodePath}" -e "require('node-pty')"`;
}

function rebuildNodePtyCmd(nodePath: string): string {
  return `cd ~/${AGENT_DIR}/pkg && "${path.posix.dirname(nodePath)}/npm" rebuild node-pty`;
}

/** Launcher script — every path is absolute and baked at enroll time. */
export function launcherScript(home: string): string {
  const root = `${home}/${AGENT_DIR}`;
  return [
    '#!/bin/sh',
    '# Installed by `terminull enroll` — re-running enroll overwrites this file.',
    '# Absolute paths on purpose: the remote PATH is never consulted at runtime',
    '# (~/.local/bin/node shadowing trap).',
    `exec "$(cat "${root}/node-path")" "${root}/pkg/dist/bin.js" agent --state-dir "${home}/${AGENT_HOST_DIR}" "$@"`,
    '',
  ].join('\n');
}

/** Derive a machine id slug from an ssh destination (`user@host` accepted). */
export function deriveMachineId(host: string): string {
  const bare = host.replace(/^.*@/, '').toLowerCase();
  const slug = bare
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+/, '')
    .slice(0, 32);
  return slug;
}

export interface EnrollOptions {
  host: string;
  id?: string;
  label?: string;
  node?: string;
  serverState: string;
}

export interface EnrollDeps {
  runner: SshRunner;
  /** Produces the agent bundle tar.gz (production: pnpm deploy + tar). */
  buildBundle: () => Promise<Buffer>;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  now?: () => Date;
}

export interface EnrollResult {
  machine: MachineConfig;
  home: string;
  nodePath: string;
  nodeVersion: string;
  shadow?: { path: string; version: string };
  reloaded: boolean;
  reloadReason?: string;
}

function mustOk(res: SshRunResult, what: string): void {
  if (res.code !== 0) {
    throw new EnrollError(
      'remote_install_failed',
      t('error.remote_install_failed', { detail: `${what}: ${tail(res)}` }),
    );
  }
}

/** Version stamp written into the remote VERSION file. */
const BUNDLE_VERSION = '0.0.0';

/**
 * Full enroll per contract §6. Idempotent: re-running upgrades in place (pkg
 * re-extracted, node re-pinned, VERSION rewritten, machines.json entry
 * upserted — never duplicated). The machine is registered ONLY after the
 * handshake probe succeeds.
 */
export async function enroll(opts: EnrollOptions, deps: EnrollDeps): Promise<EnrollResult> {
  const log = deps.log ?? (() => {});
  const { runner } = deps;
  const id = opts.id ?? deriveMachineId(opts.host);
  if (!MACHINE_ID_RE.test(id) || id === LOCAL_MACHINE_ID) {
    throw new EnrollError('machine_id_invalid', t('error.machine_id_invalid', { id }));
  }

  // 1. preflight
  const { home, uname } = await preflight(runner, opts.host);
  log(t('enroll.preflightOk', { host: opts.host, home }));
  void uname;

  // 2. node resolution + shadow-trap rejection
  const node = await resolveRemoteNode(runner, opts.host, home, opts.node);
  if (node.shadow) {
    log(
      t('enroll.shadowWarn', {
        shadow: node.shadow.path,
        shadowVersion: node.shadow.version,
        path: node.nodePath,
        version: node.version,
      }),
    );
  }
  log(t('enroll.nodePinned', { path: node.nodePath, version: node.version }));

  // 3. bundle + upload into the dedicated dir (and ONLY that dir)
  let bundle: Buffer;
  try {
    bundle = await deps.buildBundle();
  } catch (err) {
    throw new EnrollError(
      'bundle_failed',
      t('error.bundle_failed', { detail: (err as Error).message }),
    );
  }
  mustOk(await runner.run(opts.host, INSTALL_CMDS.mkdirs), 'mkdir');
  mustOk(
    await runner.run(opts.host, INSTALL_CMDS.writeNodePath, `${node.nodePath}\n`),
    'node-path',
  );
  mustOk(await runner.run(opts.host, INSTALL_CMDS.extractBundle, bundle), 'extract');
  mustOk(await runner.run(opts.host, INSTALL_CMDS.fixSpawnHelper), 'spawn-helper');
  log(t('enroll.uploaded', { dir: AGENT_DIR }));

  // 3b. node-pty native check (only when the bundle ships it)
  const hasPty = await runner.run(opts.host, INSTALL_CMDS.hasNodePty);
  if (hasPty.code === 0) {
    const check = await runner.run(opts.host, checkNodePtyCmd(node.nodePath));
    if (check.code !== 0) {
      const rebuild = await runner.run(opts.host, rebuildNodePtyCmd(node.nodePath));
      const recheck = await runner.run(opts.host, checkNodePtyCmd(node.nodePath));
      if (recheck.code !== 0) {
        throw new EnrollError(
          'remote_native_build_failed',
          t('error.remote_native_build_failed', {
            host: opts.host,
            detail: tail(rebuild.code === 0 ? recheck : rebuild),
          }),
        );
      }
    }
  }

  // 4. launcher with absolute baked paths
  mustOk(await runner.run(opts.host, INSTALL_CMDS.writeLauncher, launcherScript(home)), 'launcher');

  // 5. health handshake — the installed launcher must answer the probe
  const probe = await runner.run(opts.host, INSTALL_CMDS.probeAgent);
  if (probe.code !== 0 || !probe.stdout.includes(AGENT_PREAMBLE)) {
    throw new EnrollError(
      'agent_probe_failed',
      t('error.agent_probe_failed', { host: opts.host, detail: tail(probe) }),
    );
  }
  log(t('enroll.probeOk', { preamble: AGENT_PREAMBLE }));

  // VERSION last (write-then-rename): presence == complete install
  const stamp = `${BUNDLE_VERSION} ${(deps.now?.() ?? new Date()).toISOString()}\n`;
  mustOk(await runner.run(opts.host, INSTALL_CMDS.writeVersion, stamp), 'version');

  // 6. local registration (upsert by id — idempotent re-enroll)
  let machines: MachineConfig[];
  try {
    machines = loadMachinesFile(opts.serverState);
  } catch (err) {
    throw new EnrollError(
      'machines_file_invalid',
      t('error.machines_file_invalid', { detail: (err as Error).message }),
    );
  }
  const entry = MachineConfigSchema.parse({
    id,
    label: opts.label ?? opts.host,
    transport: { kind: 'ssh', host: opts.host },
    enabled: true,
  });
  const next = [...machines.filter((m) => m.id !== id), entry];
  saveMachinesFile(opts.serverState, next);

  const reload = await requestReload(opts.serverState, deps.fetchImpl ?? fetch);
  return {
    machine: entry,
    home,
    nodePath: node.nodePath,
    nodeVersion: node.version,
    shadow: node.shadow,
    reloaded: reload.ok,
    reloadReason: reload.ok ? undefined : reload.reason,
  };
}

// ---------------------------------------------------------------------------
// --remove — complete reversal
// ---------------------------------------------------------------------------

/**
 * Remote reversal command: best-effort daemon kill via host.pid, then remove
 * the ONLY directory enroll ever created. The trailing marker makes the
 * outcome machine-checkable instead of inferred.
 */
export const REMOVE_CMD = [
  `kill "$(cat ~/${AGENT_HOST_DIR}/${HOST_PID_FILE} 2>/dev/null)" 2>/dev/null`,
  `rm -rf ~/${AGENT_DIR}`,
  `if [ -e ~/${AGENT_DIR} ]; then echo TERMINULL-REMOVE-FAILED; else echo TERMINULL-REMOVED; fi`,
].join('; ');

export interface RemoveOptions {
  /** Machine id or ssh host to remove. */
  query: string;
  serverState: string;
}

export interface RemoveResult {
  /** Registry id that was deregistered; null when no entry matched. */
  id: string | null;
  /** Host the remote cleanup ran against; null when none applied. */
  host: string | null;
  remote: 'removed' | 'failed' | 'unreachable' | 'skipped';
  remoteDetail?: string;
  entryRemoved: boolean;
  reloaded: boolean;
  reloadReason?: string;
}

/** Full reversal per contract §6 `--remove`. Honest about partial outcomes. */
export async function removeEnrollment(
  opts: RemoveOptions,
  deps: EnrollDeps,
): Promise<RemoveResult> {
  let machines: MachineConfig[];
  try {
    machines = loadMachinesFile(opts.serverState);
  } catch (err) {
    throw new EnrollError(
      'machines_file_invalid',
      t('error.machines_file_invalid', { detail: (err as Error).message }),
    );
  }
  const entry =
    machines.find((m) => m.id === opts.query) ??
    machines.find((m) => m.transport.kind === 'ssh' && m.transport.host === opts.query);

  // Resolve which host (if any) to clean remotely. An entry with a non-ssh
  // transport (e.g. test stdio machines) has no remote footprint to remove.
  const host =
    entry === undefined ? opts.query : entry.transport.kind === 'ssh' ? entry.transport.host : null;

  let remote: RemoveResult['remote'] = 'skipped';
  let remoteDetail: string | undefined;
  if (host !== null) {
    const res = await deps.runner.run(host, REMOVE_CMD);
    if (res.stdout.includes('TERMINULL-REMOVED')) {
      remote = 'removed';
    } else if (res.stdout.includes('TERMINULL-REMOVE-FAILED')) {
      remote = 'failed';
      remoteDetail = tail(res);
    } else {
      remote = 'unreachable';
      remoteDetail = tail(res);
    }
  }

  let entryRemoved = false;
  if (entry) {
    saveMachinesFile(
      opts.serverState,
      machines.filter((m) => m.id !== entry.id),
    );
    entryRemoved = true;
  }

  const reload = await requestReload(opts.serverState, deps.fetchImpl ?? fetch);
  return {
    id: entry?.id ?? null,
    host,
    remote,
    remoteDetail,
    entryRemoved,
    reloaded: reload.ok,
    reloadReason: reload.ok ? undefined : reload.reason,
  };
}
