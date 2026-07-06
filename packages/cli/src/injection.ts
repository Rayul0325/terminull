/**
 * CLI injection orchestration — the consent-shaped, provenance-backed bridge
 * between the per-tool ADAPTER injectors (file mechanics: copy hook scripts,
 * surgically patch the config file) and the CORE {@link InjectionEngine}
 * (the `injected.json` ledger + drift-respecting eject).
 *
 * Composition (contract §D2):
 *  - {@link injectTool} snapshots the config file BYTE-VERBATIM, backs it up
 *    under `<stateDir>/backups/injected/`, runs the adapter injector, then
 *    records exactly what changed (config record + one record per copied
 *    script) in the ledger. The ledger — not the tool home — is the source of
 *    truth for "did Terminull inject this"; a second `injectTool` is a no-op.
 *  - {@link ejectTool} delegates to `InjectionEngine.eject` (restore-or-strip
 *    per the drift policy), then removes the now-empty hook dirs and the
 *    adapter's own `.terminull.bak-*` safety copies.
 *
 * Every path is home-injectable: `ctx.home` selects the tool home, `stateDir`
 * selects the ledger + backups, so ALL tests run against fake homes under
 * `os.tmpdir()` — never the real `~/.claude` / `~/.codex`.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeHarnessInjector, HOOK_SPECS } from '@terminull/adapter-claude';
import { CodexNotifyInjector, NOTIFY_SCRIPT } from '@terminull/adapter-codex';
import type { HarnessContext, HarnessInjector } from '@terminull/adapter-sdk';
import {
  type EjectReport,
  type InjectedFileRecord,
  InjectionEngine,
  contentSha,
  minimalInsertedRun,
  writeVerbatimBackup,
} from '@terminull/core';

/** The tools whose harness Terminull can inject (agy exposes no hooks). */
export const INJECTABLE_TOOLS = ['claude', 'codex'] as const;
export type InjectableTool = (typeof INJECTABLE_TOOLS)[number];

/** Per-tool wiring the CLI needs beyond the opaque {@link HarnessInjector}. */
interface ToolWiring {
  /** Detection binary name (`which <bin>`). */
  bin: string;
  /** Build the adapter injector, optionally overriding its harness source dir. */
  injector(harnessDir?: string): HarnessInjector;
  /** The config file we snapshot for the ledger (settings.json / config.toml). */
  configPath(home: string): string;
  /** The `terminull/hooks` dir the scripts are copied into. */
  hooksDir(home: string): string;
  /** Ledger anchor label for the config record. */
  anchor: string;
}

const WIRING: Record<InjectableTool, ToolWiring> = {
  claude: {
    bin: 'claude',
    injector: (harnessDir) =>
      new ClaudeHarnessInjector(harnessDir ? { harnessDir } : {}),
    configPath: (home) => path.join(home, '.claude', 'settings.json'),
    hooksDir: (home) => path.join(home, '.claude', 'terminull', 'hooks'),
    anchor: 'hooks',
  },
  codex: {
    bin: 'codex',
    injector: (harnessDir) => new CodexNotifyInjector(harnessDir ? { harnessDir } : {}),
    configPath: (home) => path.join(home, '.codex', 'config.toml'),
    hooksDir: (home) => path.join(home, '.codex', 'terminull', 'hooks'),
    anchor: 'notify',
  },
};

/**
 * Harness scripts (`terminull-*.sh`) are DATA files the adapters resolve via
 * `import.meta.url` — which points at the ADAPTER package in dev, but at the
 * single tsup bundle once published. So prepack copies each adapter's harness
 * dir to `<bundle>/harness/<tool>/`; here we detect that co-located copy and
 * override the injector's source. Absent (dev/test) → the adapter default (its
 * own `harness/`) is used, which is why the dev tests never see this path.
 */
function bundledHarnessDir(tool: InjectableTool): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidate = path.join(here, 'harness', tool);
  return fs.existsSync(candidate) ? candidate : undefined;
}

function injectorFor(tool: InjectableTool): HarnessInjector {
  return WIRING[tool].injector(bundledHarnessDir(tool));
}

/** True when `tool` is one Terminull knows how to inject. */
export function isInjectableTool(tool: string): tool is InjectableTool {
  return (INJECTABLE_TOOLS as readonly string[]).includes(tool);
}

/** Binary name to probe for a given injectable tool. */
export function toolBinary(tool: InjectableTool): string {
  return WIRING[tool].bin;
}

async function readMaybe(file: string): Promise<string | null> {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** The absolute script paths one tool copies into its hooks dir (post-install). */
function scriptFiles(tool: InjectableTool, home: string): string[] {
  const dir = WIRING[tool].hooksDir(home);
  if (tool === 'claude') {
    const files = new Set<string>(['terminull-lib.sh']);
    for (const spec of HOOK_SPECS) files.add(spec.file);
    return [...files].map((f) => path.join(dir, f));
  }
  return [NOTIFY_SCRIPT, 'terminull-lib.sh'].map((f) => path.join(dir, f));
}

/** Human-readable preview of what an install would change (from the adapter). */
export async function previewTool(tool: InjectableTool, home: string): Promise<string> {
  const injector = injectorFor(tool);
  const withPlan = injector as HarnessInjector & {
    plan?: (ctx: HarnessContext) => Promise<{ text: string }>;
  };
  if (typeof withPlan.plan === 'function') {
    return (await withPlan.plan({ home })).text;
  }
  return `${tool}: install Terminull harness`;
}

/** Outcome of {@link injectTool}. */
export interface InjectOutcome {
  tool: InjectableTool;
  /** `injected` = we changed something; `already` = ledger entry existed. */
  status: 'injected' | 'already' | 'failed';
  /** Human detail (en/ko chosen by the caller from the returned reason). */
  detail?: string;
  /** Files recorded in the ledger (empty on failure/already). */
  files: number;
}

/**
 * Inject one tool's harness and record provenance. Idempotent: if the ledger
 * already carries this tool, nothing is touched. On a fresh install the config
 * file is backed up verbatim BEFORE the adapter patches it, so eject can
 * restore byte-identically.
 */
export async function injectTool(
  tool: InjectableTool,
  opts: { home: string; stateDir: string; engine: InjectionEngine; now?: () => number },
): Promise<InjectOutcome> {
  const { home, stateDir, engine } = opts;
  const now = opts.now ?? Date.now;
  if (await engine.status(tool)) {
    return { tool, status: 'already', files: 0 };
  }

  const wiring = WIRING[tool];
  const ctx: HarnessContext = { home };
  const configPath = wiring.configPath(home);
  const before = await readMaybe(configPath);
  const backupPath = before !== null ? await writeVerbatimBackup(stateDir, tool, configPath, before) : null;

  const status = await injectorFor(tool).install(ctx);
  if (!status.installed) {
    return { tool, status: 'failed', detail: status.detail?.en, files: 0 };
  }

  const after = await readMaybe(configPath);
  const files: InjectedFileRecord[] = [];
  if (after !== null) {
    files.push({
      path: configPath,
      action: before === null ? 'created' : 'patched',
      anchor: wiring.anchor,
      addedBytes: before === null ? null : minimalInsertedRun(before, after),
      shaBefore: before === null ? null : contentSha(before),
      shaAfter: contentSha(after),
      backupPath,
    });
  }
  for (const script of scriptFiles(tool, home)) {
    const bytes = await readMaybe(script);
    if (bytes === null) continue; // adapter chose not to ship it
    files.push({
      path: script,
      action: 'created',
      anchor: 'script',
      addedBytes: null,
      shaBefore: null,
      shaAfter: contentSha(bytes),
      backupPath: null,
    });
  }

  await engine.record({ tool, installedAt: now(), files });
  return { tool, status: 'injected', files: files.length };
}

/**
 * Eject one tool: drift-respecting restore/strip via the engine, then remove
 * the emptied hook dirs and the adapter's own `.terminull.bak-*` copies. The
 * `EjectReport.clean` flag tells the caller whether any file was left drifted.
 */
export async function ejectTool(
  tool: InjectableTool,
  opts: { home: string; engine: InjectionEngine },
): Promise<EjectReport> {
  const report = await opts.engine.eject(tool);

  // Best-effort tidy: emptied hook dir + adapter backups (all Terminull-owned).
  const wiring = WIRING[tool];
  const hooksDir = wiring.hooksDir(opts.home);
  await fsp.rm(hooksDir, { recursive: true, force: true }).catch(() => {});
  await fsp.rmdir(path.dirname(hooksDir)).catch(() => {});

  const configDir = path.dirname(wiring.configPath(opts.home));
  const base = path.basename(wiring.configPath(opts.home)) + '.terminull.bak-';
  try {
    for (const f of await fsp.readdir(configDir)) {
      if (f.startsWith(base)) await fsp.unlink(path.join(configDir, f)).catch(() => {});
    }
  } catch {
    /* config dir gone */
  }
  return report;
}

/** The injected script path used for the synthetic-event healthcheck, if any. */
export function healthcheckScript(tool: InjectableTool, home: string): string {
  const dir = WIRING[tool].hooksDir(home);
  return tool === 'claude'
    ? path.join(dir, 'terminull-session-start.sh')
    : path.join(dir, NOTIFY_SCRIPT);
}
