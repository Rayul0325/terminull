/**
 * Product command surface (contract §D3): `setup`, `inject`, `eject`,
 * `doctor`, `uninstall`. Every side effect flows through injected seams
 * ({@link SetupDeps}) so the entire flow runs against fake homes under
 * `os.tmpdir()` — never the real `~/.claude` / `~/.codex` / `~/.terminull`.
 *
 * Trust-shaped by construction: setup DETECTS tools honestly (missing = skip),
 * PREVIEWS the exact diff per tool, asks for consent PER TOOL (`--yes` accepts
 * all, for CI/tests), records provenance so eject is byte-reversible, and NEVER
 * purges the data dir without an explicit `--purge` + interactive confirm.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { INJECTED_LEDGER_FILE, InjectionEngine, contentSha } from '@terminull/core';
import {
  type ExecFileFn,
  type HealthcheckResult,
  realExecFile,
  syntheticHealthcheck,
} from './healthcheck.js';
import {
  INJECTABLE_TOOLS,
  type InjectableTool,
  ejectTool,
  healthcheckScript,
  injectTool,
  isInjectableTool,
  previewTool,
  toolBinary,
} from './injection.js';
import { t } from './messages.js';
import { liveServer } from './server-api.js';
import type { ServiceManager, ServiceSpec } from './service.js';

/** Detected CLI tool presence + version (honest: absent = `present:false`). */
export interface ToolDetection {
  present: boolean;
  version?: string;
  path?: string;
}

/** Injected side-effect surface for the product commands. */
export interface SetupDeps {
  /** User home selecting the tool homes (`<home>/.claude`, …). */
  home: string;
  /** Terminull state dir (`<home>/.terminull` by default) — ledger + backups. */
  stateDir: string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  /** Probe a CLI binary (`which` + `--version`). Seam: tests never shell out. */
  detectTool: (bin: string) => Promise<ToolDetection>;
  /** Interactive y/N consent. `--yes` bypasses this entirely. */
  prompt: (question: string) => Promise<boolean>;
  serviceManager: ServiceManager;
  /** Absolute node binary for the service plist (`process.execPath`). */
  nodePath: string;
  /** Absolute entry script for the service (`serve`). */
  entry: string;
  execFileImpl?: ExecFileFn;
  fetchImpl?: typeof fetch;
  coreVersion: string;
  now?: () => number;
}

function engineFor(deps: SetupDeps): InjectionEngine {
  return new InjectionEngine({ ledgerPath: path.join(deps.stateDir, INJECTED_LEDGER_FILE) });
}

/** Resolve which injectable tools to act on (one named, or all). */
function selectedTools(tool: string | undefined, deps: SetupDeps): InjectableTool[] | null {
  if (tool === undefined) return [...INJECTABLE_TOOLS];
  if (!isInjectableTool(tool)) {
    deps.stderr(t('setup.unknownTool', { tool, tools: INJECTABLE_TOOLS.join(', ') }));
    return null;
  }
  return [tool];
}

function nodeMajor(): number {
  return Number((process.versions.node ?? '0').split('.')[0]);
}

/** Shared detect → preview → consent → inject loop. */
async function injectFlow(
  tools: InjectableTool[],
  values: { yes?: boolean },
  deps: SetupDeps,
  engine: InjectionEngine,
): Promise<{ injected: InjectableTool[]; anyPresent: boolean }> {
  const injected: InjectableTool[] = [];
  let anyPresent = false;
  for (const tool of tools) {
    const detection = await deps.detectTool(toolBinary(tool));
    if (!detection.present) {
      deps.stdout(t('setup.toolMissing', { tool }));
      continue;
    }
    anyPresent = true;
    deps.stdout(t('setup.toolFound', { tool, version: detection.version ?? '?' }));

    if (await engine.status(tool)) {
      deps.stdout(t('setup.alreadyInjected', { tool }));
      injected.push(tool);
      continue;
    }

    deps.stdout(await previewTool(tool, deps.home));
    const consent = values.yes === true || (await deps.prompt(t('setup.consent', { tool })));
    if (!consent) {
      deps.stdout(t('setup.skipped', { tool }));
      continue;
    }
    const outcome = await injectTool(tool, {
      home: deps.home,
      stateDir: deps.stateDir,
      engine,
      ...(deps.now ? { now: deps.now } : {}),
    });
    if (outcome.status === 'failed') {
      deps.stderr(t('setup.injectFailed', { tool, detail: outcome.detail ?? '' }));
      continue;
    }
    deps.stdout(t('setup.injected', { tool, files: outcome.files }));
    injected.push(tool);
  }
  return { injected, anyPresent };
}

/** `terminull setup [tool] [--yes] [--server-state <dir>]`. */
export async function runSetup(
  values: { yes?: boolean; tool?: string },
  deps: SetupDeps,
): Promise<number> {
  if (nodeMajor() < 22) {
    deps.stderr(t('setup.nodeTooOld', { version: process.versions.node ?? '?' }));
    return 1;
  }
  const tools = selectedTools(values.tool, deps);
  if (!tools) return 2;

  const engine = engineFor(deps);
  const { injected, anyPresent } = await injectFlow(tools, values, deps, engine);
  if (!anyPresent) {
    deps.stdout(t('setup.noTools'));
  }

  // Service install (honest unsupported note on non-darwin).
  const spec: ServiceSpec = {
    nodePath: deps.nodePath,
    entry: deps.entry,
    serveArgs: ['serve'],
    stateDir: deps.stateDir,
    logDir: path.join(deps.stateDir, 'logs'),
  };
  const svc = await deps.serviceManager.install(spec);
  if (svc.ok) deps.stdout(t('setup.serviceInstalled'));
  else if (svc.code === 'unsupported') deps.stdout(t('setup.serviceUnsupported'));
  else deps.stderr(t('setup.serviceFailed', { detail: svc.detail ?? svc.code }));

  // Synthetic-event healthcheck through each injected artifact (if panel live).
  const server = liveServer(deps.stateDir);
  if (server && injected.length > 0) {
    const url = `http://127.0.0.1:${server.port}`;
    for (const tool of injected) {
      const res = await syntheticHealthcheck({
        tool,
        scriptPath: healthcheckScript(tool, deps.home),
        url,
        execFileImpl: deps.execFileImpl ?? realExecFile,
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      });
      deps.stdout(healthcheckLine(tool, res));
    }
    deps.stdout(t('setup.panelUrl', { url }));
  } else {
    deps.stdout(t('setup.panelNotRunning'));
  }
  return 0;
}

function healthcheckLine(tool: InjectableTool, res: HealthcheckResult): string {
  if (res.status === 'passed') return t('setup.healthOk', { tool });
  if (res.status === 'unavailable') return t('setup.healthUnavailable', { tool, detail: res.detail });
  return t('setup.healthFailed', { tool, detail: res.detail });
}

/** `terminull inject [tool] [--yes]` — the injection slice alone. */
export async function runInject(
  values: { yes?: boolean; tool?: string },
  deps: SetupDeps,
): Promise<number> {
  const tools = selectedTools(values.tool, deps);
  if (!tools) return 2;
  const engine = engineFor(deps);
  await injectFlow(tools, values, deps, engine);
  return 0;
}

/** `terminull eject [tool]` — drift-respecting removal, per-file outcomes. */
export async function runEject(values: { tool?: string }, deps: SetupDeps): Promise<number> {
  const tools = selectedTools(values.tool, deps);
  if (!tools) return 2;
  const engine = engineFor(deps);
  let allClean = true;
  for (const tool of tools) {
    const report = await ejectTool(tool, { home: deps.home, engine });
    if (report.files.length === 0) {
      deps.stdout(t('eject.nothing', { tool }));
      continue;
    }
    for (const f of report.files) {
      deps.stdout(t('eject.file', { path: f.path, outcome: f.outcome }));
      if (f.warning) deps.stderr(`  ⚠ ${f.warning}`);
    }
    if (!report.clean) {
      allClean = false;
      deps.stderr(t('eject.drift', { tool }));
    } else {
      deps.stdout(t('eject.clean', { tool }));
    }
  }
  return allClean ? 0 : 1;
}

/** `terminull doctor` — env/state/socket/service/version + core integrity. */
export async function runDoctor(deps: SetupDeps): Promise<number> {
  let healthy = true;
  const ok = (line: string): void => deps.stdout(`  ✓ ${line}`);
  const bad = (line: string): void => {
    healthy = false;
    deps.stderr(`  ✖ ${line}`);
  };

  deps.stdout(t('doctor.header'));

  // Environment.
  if (nodeMajor() >= 22) ok(t('doctor.node', { version: process.versions.node ?? '?' }));
  else bad(t('doctor.nodeTooOld', { version: process.versions.node ?? '?' }));

  // State dir + server discovery + pid liveness + socket.
  const server = liveServer(deps.stateDir);
  if (!server) {
    deps.stdout(t('doctor.serverDown'));
  } else {
    ok(t('doctor.serverLive', { port: server.port, pid: server.pid }));
    const url = `http://127.0.0.1:${server.port}`;
    try {
      const res = await (deps.fetchImpl ?? fetch)(`${url}/api/events?since=0`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (res.ok) ok(t('doctor.socketOk', { url }));
      else bad(t('doctor.socketBad', { url, status: String(res.status) }));
    } catch (err) {
      bad(t('doctor.socketBad', { url, status: (err as Error).message }));
    }
  }

  // Service status.
  const svc = await deps.serviceManager.status();
  if (!svc.supported) deps.stdout(t('doctor.serviceUnsupported'));
  else if (svc.installed && svc.loaded) ok(t('doctor.serviceLoaded'));
  else if (svc.installed) bad(t('doctor.serviceNotLoaded'));
  else deps.stdout(t('doctor.serviceAbsent'));

  // Version.
  deps.stdout(t('doctor.version', { version: deps.coreVersion }));

  // Core-integrity: every injected artifact still matches its recorded sha.
  const engine = engineFor(deps);
  const ledger = await engine.load();
  if (ledger.tools.length === 0) {
    deps.stdout(t('doctor.noInjection'));
  }
  for (const tool of ledger.tools) {
    let toolOk = true;
    for (const file of tool.files) {
      let current: string | null;
      try {
        current = await fsp.readFile(file.path, 'utf8');
      } catch {
        current = null;
      }
      if (current === null) {
        toolOk = false;
        bad(t('doctor.integrityMissing', { tool: tool.tool, path: file.path }));
      } else if (file.action === 'created' && contentSha(current) !== file.shaAfter) {
        toolOk = false;
        bad(t('doctor.integrityDrift', { tool: tool.tool, path: file.path }));
      }
    }
    if (toolOk) ok(t('doctor.integrityOk', { tool: tool.tool }));
  }

  deps.stdout(healthy ? t('doctor.healthy') : t('doctor.unhealthy'));
  return healthy ? 0 : 1;
}

/**
 * `terminull uninstall [--purge] [--yes]` — eject ALL tools (drift-respecting)
 * → remove the service → remove the data dir ONLY after `--purge` AND an
 * interactive confirm. `--yes` alone NEVER purges data (contract §D3).
 */
export async function runUninstall(
  values: { purge?: boolean; yes?: boolean },
  deps: SetupDeps,
): Promise<number> {
  const engine = engineFor(deps);
  let allClean = true;
  for (const tool of INJECTABLE_TOOLS) {
    if (!(await engine.status(tool))) continue;
    const report = await ejectTool(tool, { home: deps.home, engine });
    for (const f of report.files) deps.stdout(t('eject.file', { path: f.path, outcome: f.outcome }));
    if (!report.clean) {
      allClean = false;
      deps.stderr(t('eject.drift', { tool }));
    }
  }

  const svc = await deps.serviceManager.uninstall();
  if (svc.ok) deps.stdout(t('uninstall.serviceRemoved'));
  else if (svc.code === 'unsupported') deps.stdout(t('setup.serviceUnsupported'));
  else deps.stderr(t('uninstall.serviceFailed', { detail: svc.detail ?? svc.code }));

  if (!values.purge) {
    deps.stdout(t('uninstall.dataKept', { dir: deps.stateDir }));
    return allClean ? 0 : 1;
  }
  // --purge STILL requires an explicit interactive yes (never just --yes).
  const confirmed = await deps.prompt(t('uninstall.purgeConfirm', { dir: deps.stateDir }));
  if (!confirmed) {
    deps.stdout(t('uninstall.dataKept', { dir: deps.stateDir }));
    return allClean ? 0 : 1;
  }
  await fsp.rm(deps.stateDir, { recursive: true, force: true });
  deps.stdout(t('uninstall.dataPurged', { dir: deps.stateDir }));
  return allClean ? 0 : 1;
}
