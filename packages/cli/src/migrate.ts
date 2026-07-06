/**
 * `terminull migrate --from control-tower` (M11) — migrate THIS machine's legacy
 * "Control Tower" harness (the pre-Terminull JARVIS panel under
 * `~/.claude/control-tower/`) onto Terminull's consent-shaped, reversible model.
 *
 * SHAPE (contract §M11):
 *  - DRY-RUN BY DEFAULT: `detectLegacy` builds an honest {@link LegacyFootprint}
 *    (settings.json hooks / codex notify / LaunchAgent plist / events+state
 *    store) and {@link renderMigrationPlan} prints a `항목 / 위치 / 조치` table.
 *    Nothing is touched.
 *  - `--execute` applies, and EVERY step is reversible + logged:
 *      (a) surgically strip ONLY the control-tower hook entries from
 *          settings.json (foreign hooks preserved), after a verbatim backup via
 *          the existing backup story ({@link writeVerbatimBackup});
 *      (b) restore codex `notify` to its pre-control-tower value IFF the legacy
 *          value wraps the tower (the `ct-codex-notify.sh` wrapper preserves the
 *          original client as its tail args, so removing element[0] restores it);
 *          re-injection is left to `terminull inject codex` (a printed follow-up);
 *      (c) `launchctl bootout` the tower LaunchAgent and MOVE its plist into the
 *          archive;
 *      (d) MOVE (never delete) the tower events.jsonl + state into
 *          `<data>/migrate-archive/<ts>/` with a `manifest.json` recording every
 *          moved path + sha;
 *      (e) print a ROLLBACK block: the exact commands to restore each step.
 *  - IDEMPOTENT: a second run finds nothing → honest "migrate 대상 없음", exit 0.
 *    Every item is detected independently, so partial legacy states are handled.
 *  - The control-tower DIR itself is NOT deleted: only the hooks/service/notify
 *    wiring + event store are migrated, so parallel operation stays possible.
 *
 * TESTABILITY: every effect flows through injected seams ({@link MigrateDeps}) —
 * `home` selects the tool homes, `stateDir` the archive/backup root,
 * `launchAgentsDir` the plist dir, `launchctl` the runner (never the real one) —
 * so all tests run against fake homes under `os.tmpdir()` and NEVER touch the
 * real `~/.claude/control-tower`, `~/.codex`, or `~/Library/LaunchAgents`.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { contentSha, tomlArrayLineRemove, writeVerbatimBackup } from '@terminull/core';
import { t } from './messages.js';
import type { LaunchctlRunner } from './service.js';

/** The only migration source Terminull knows in v0.x. */
export const MIGRATION_SOURCE = 'control-tower' as const;
export type MigrationSource = typeof MIGRATION_SOURCE;

// ---------------------------------------------------------------------------
// Footprint model
// ---------------------------------------------------------------------------

/** One control-tower hook entry found in settings.json. */
export interface HookHit {
  event: string;
  matcher?: string;
  command: string;
}

/** A control-tower LaunchAgent plist. */
export interface LaunchAgentHit {
  label: string;
  plistPath: string;
}

/** A codex `notify` line whose element[0] wraps the tower. */
export interface CodexNotifyHit {
  configPath: string;
  /** The EXACT TOML token (with quotes) to strip — the wrapper path. */
  wrapperElement: string;
  /** The full notify array as parsed (for the plan display). */
  notify: string[];
}

/** One file under the tower state dir that would be archived. */
export interface StateFileHit {
  path: string;
  bytes: number;
}

/** Everything a legacy control-tower install leaves on this machine. */
export interface LegacyFootprint {
  source: MigrationSource;
  controlTowerDir: string;
  /** `null` when settings.json is absent/unreadable. */
  hooks: { settingsPath: string; hits: HookHit[] } | null;
  launchAgents: LaunchAgentHit[];
  /** `null` when codex notify is absent or not control-tower. */
  codexNotify: CodexNotifyHit | null;
  stateFiles: { stateDir: string; files: StateFileHit[] };
  /** True when ANY item was found (drives the "nothing to migrate" path). */
  anyFound: boolean;
}

// ---------------------------------------------------------------------------
// Detection (READ-ONLY)
// ---------------------------------------------------------------------------

/** True when a hook `command` points into a `control-tower/` path. */
export function isControlTowerCommand(cmd: unknown): boolean {
  return typeof cmd === 'string' && cmd.includes('/control-tower/');
}

interface HookEntry {
  type?: string;
  command?: unknown;
  [k: string]: unknown;
}
interface HookGroup {
  matcher?: string;
  hooks?: HookEntry[];
  [k: string]: unknown;
}
type Settings = Record<string, unknown> & { hooks?: Record<string, HookGroup[]> };

/** Find every control-tower hook in a settings.json body (pure). */
export function detectControlTowerHooks(settingsText: string): HookHit[] {
  let obj: Settings;
  try {
    obj = JSON.parse(settingsText) as Settings;
  } catch {
    return []; // unparseable settings → nothing we can surgically touch
  }
  const hooks = obj.hooks ?? {};
  const hits: HookHit[] = [];
  for (const event of Object.keys(hooks)) {
    for (const group of hooks[event] ?? []) {
      for (const h of group.hooks ?? []) {
        if (isControlTowerCommand(h.command)) {
          hits.push({
            event,
            ...(group.matcher !== undefined ? { matcher: group.matcher } : {}),
            command: String(h.command),
          });
        }
      }
    }
  }
  return hits;
}

/**
 * Remove EXACTLY the control-tower hook entries from a settings object,
 * preserving every foreign hook (same command/matcher/order). Mirrors the
 * proven adapter-claude `stripOurHooks` shape, with a control-tower predicate.
 * Pure: returns a fresh clone; empty groups/events are dropped.
 */
export function stripControlTowerHooks(settings: Settings): Settings {
  const out = JSON.parse(JSON.stringify(settings)) as Settings;
  const hooks = out.hooks;
  if (!hooks) return out;
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event] ?? [];
    const kept: HookGroup[] = [];
    for (const g of groups) {
      const entries = Array.isArray(g.hooks) ? g.hooks : [];
      const foreign = entries.filter((h) => !isControlTowerCommand(h.command));
      if (foreign.length === 0) continue; // group was entirely control-tower → drop
      kept.push({ ...g, hooks: foreign });
    }
    if (kept.length === 0) delete hooks[event];
    else hooks[event] = kept;
  }
  if (Object.keys(hooks).length === 0) delete out.hooks;
  return out;
}

/** Extract a plist's `Label` string, or null. */
function plistLabel(text: string): string | null {
  const m = /<key>\s*Label\s*<\/key>\s*<string>([^<]*)<\/string>/.exec(text);
  return m ? (m[1] ?? '').trim() : null;
}

/** Scan a LaunchAgents dir for plists that reference control-tower (read-only). */
export async function detectLaunchAgents(launchAgentsDir: string): Promise<LaunchAgentHit[]> {
  let names: string[];
  try {
    names = await fsp.readdir(launchAgentsDir);
  } catch {
    return [];
  }
  const hits: LaunchAgentHit[] = [];
  for (const name of names) {
    if (!name.endsWith('.plist')) continue;
    const plistPath = path.join(launchAgentsDir, name);
    let text: string;
    try {
      text = await fsp.readFile(plistPath, 'utf8');
    } catch {
      continue;
    }
    // A tower agent runs the control-tower server (ProgramArguments/WorkingDir);
    // other rayul agents (loops, quizserver, …) never reference control-tower.
    if (!text.includes('control-tower')) continue;
    const label = plistLabel(text) ?? name.replace(/\.plist$/, '');
    hits.push({ label, plistPath });
  }
  return hits;
}

/** First `"…"` token inside a single-line `notify = [ … ]` array (pure). */
function firstNotifyElement(tomlText: string): { element: string; all: string[] } | null {
  const m = /(?:^|\n)[^\S\n]*notify[^\S\n]*=[^\S\n]*\[([^\]\n]*)\]/.exec(tomlText);
  if (!m) return null;
  const inside = m[1] ?? '';
  const tokens = inside.match(/"(?:[^"\\]|\\.)*"/g) ?? [];
  if (tokens.length === 0) return null;
  const first = tokens[0];
  if (first === undefined) return null;
  return { element: first, all: tokens.map((tok) => tok.slice(1, -1)) };
}

/** Detect a control-tower codex notify wrapper (pure). */
export function detectCodexNotify(tomlText: string, configPath: string): CodexNotifyHit | null {
  const parsed = firstNotifyElement(tomlText);
  if (!parsed) return null;
  // The wrapper is element[0]; it is control-tower iff its path says so.
  if (!parsed.element.includes('control-tower') && !parsed.element.includes('ct-codex-notify')) {
    return null;
  }
  return { configPath, wrapperElement: parsed.element, notify: parsed.all };
}

/** List the files under `<controlTowerDir>/state/` that would be archived. */
export async function detectStateFiles(
  controlTowerDir: string,
): Promise<{ stateDir: string; files: StateFileHit[] }> {
  const stateDir = path.join(controlTowerDir, 'state');
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(stateDir, { withFileTypes: true });
  } catch {
    return { stateDir, files: [] };
  }
  const files: StateFileHit[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const p = path.join(stateDir, e.name);
    try {
      const st = await fsp.stat(p);
      files.push({ path: p, bytes: st.size });
    } catch {
      /* raced away */
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { stateDir, files };
}

async function readMaybe(file: string): Promise<string | null> {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Build the full legacy footprint for `<home>` (all reads; no writes). */
export async function detectLegacy(deps: MigrateDeps): Promise<LegacyFootprint> {
  const controlTowerDir = path.join(deps.home, '.claude', 'control-tower');
  const settingsPath = path.join(deps.home, '.claude', 'settings.json');
  const codexConfigPath = path.join(deps.home, '.codex', 'config.toml');

  const settingsText = await readMaybe(settingsPath);
  const hooks =
    settingsText === null ? null : { settingsPath, hits: detectControlTowerHooks(settingsText) };

  const launchAgents = await detectLaunchAgents(deps.launchAgentsDir);

  const codexText = await readMaybe(codexConfigPath);
  const codexNotify = codexText === null ? null : detectCodexNotify(codexText, codexConfigPath);

  const stateFiles = await detectStateFiles(controlTowerDir);

  const anyFound =
    (hooks?.hits.length ?? 0) > 0 ||
    launchAgents.length > 0 ||
    codexNotify !== null ||
    stateFiles.files.length > 0;

  return {
    source: MIGRATION_SOURCE,
    controlTowerDir,
    hooks,
    launchAgents,
    codexNotify,
    stateFiles,
    anyFound,
  };
}

// ---------------------------------------------------------------------------
// Dry-run plan rendering (Korean-first `항목 / 위치 / 조치` table)
// ---------------------------------------------------------------------------

/** Render the human dry-run/execute plan as Korean lines. */
export function renderMigrationPlan(fp: LegacyFootprint, opts: { execute: boolean }): string[] {
  const lines: string[] = [];
  lines.push(
    t(opts.execute ? 'migrate.headerExecute' : 'migrate.header', { dir: fp.controlTowerDir }),
  );
  lines.push('');
  lines.push(t('migrate.tableHead'));
  lines.push('  ─────────────────────────────────────────────');

  // 1) Claude hooks
  const hookCount = fp.hooks?.hits.length ?? 0;
  lines.push(
    t('migrate.rowHooks', {
      where: hookCount > 0 ? (fp.hooks?.settingsPath ?? '-') : '-',
      action: hookCount > 0 ? t('migrate.actHooks', { count: hookCount }) : t('migrate.actNone'),
    }),
  );
  for (const h of fp.hooks?.hits ?? []) {
    lines.push(`      · ${h.event}${h.matcher ? `(${h.matcher})` : ''} → ${h.command}`);
  }

  // 2) Codex notify
  lines.push(
    t('migrate.rowNotify', {
      where: fp.codexNotify ? fp.codexNotify.configPath : '-',
      action: fp.codexNotify ? t('migrate.actNotify') : t('migrate.actNone'),
    }),
  );

  // 3) LaunchAgent service
  lines.push(
    t('migrate.rowService', {
      where: fp.launchAgents.length > 0 ? fp.launchAgents.map((a) => a.plistPath).join(', ') : '-',
      action:
        fp.launchAgents.length > 0
          ? t('migrate.actService', { labels: fp.launchAgents.map((a) => a.label).join(', ') })
          : t('migrate.actNone'),
    }),
  );

  // 4) Event/state store
  const stateCount = fp.stateFiles.files.length;
  lines.push(
    t('migrate.rowState', {
      where: stateCount > 0 ? fp.stateFiles.stateDir : '-',
      action: stateCount > 0 ? t('migrate.actState', { count: stateCount }) : t('migrate.actNone'),
    }),
  );

  lines.push('  ─────────────────────────────────────────────');
  lines.push(t('migrate.dirKept', { dir: fp.controlTowerDir }));
  if (!opts.execute) {
    lines.push('');
    lines.push(t('migrate.executeHint'));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Execute (reversible + logged)
// ---------------------------------------------------------------------------

/** Injected side-effect surface for detect + execute. */
export interface MigrateDeps {
  /** User home selecting the tool homes (`<home>/.claude`, `<home>/.codex`). */
  home: string;
  /** Terminull data dir — archive + backup root. */
  stateDir: string;
  /** LaunchAgents dir holding the plist(s). */
  launchAgentsDir: string;
  /** launchctl seam — NEVER the real binary in tests. */
  launchctl: LaunchctlRunner;
  /** uid for the `gui/<uid>/<label>` launchd domain target. */
  uid: number;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  now: () => number;
}

/** One moved file recorded in the manifest. */
interface MovedFile {
  from: string;
  to: string;
  sha: string;
}

/** The per-run manifest written to `<archive>/manifest.json`. */
export interface MigrationManifest {
  version: 1;
  source: MigrationSource;
  migratedAt: number;
  controlTowerDir: string;
  settings?: {
    path: string;
    backup: string;
    removedHooks: HookHit[];
    shaBefore: string;
    shaAfter: string;
  };
  codexNotify?: {
    path: string;
    backup: string;
    wrapperElement: string;
    shaBefore: string;
    shaAfter: string;
  };
  launchAgents: {
    label: string;
    originalPath: string;
    archivedPath: string;
    sha: string;
    bootout: { target: string; code: number };
  }[];
  stateArchive: MovedFile[];
}

/** Outcome of {@link executeMigration}. */
export interface MigrationOutcome {
  archiveDir: string;
  manifestPath: string;
  manifest: MigrationManifest;
  /** Exact shell commands that undo this migration (printed to the user). */
  rollback: string[];
}

async function atomicWrite(file: string, bytes: string, mode = 0o600): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, bytes, { mode });
  await fsp.rename(tmp, file);
}

/** Move a file (rename; cross-device EXDEV → copy+unlink). Never reads content. */
async function moveFile(from: string, to: string): Promise<void> {
  await fsp.mkdir(path.dirname(to), { recursive: true });
  try {
    await fsp.rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await fsp.copyFile(from, to);
    await fsp.unlink(from);
  }
}

/** Shell-quote a path for a rollback command line (single-quote, POSIX-safe). */
function q(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/**
 * Apply the migration described by `fp`. Assumes `fp.anyFound` is true (the
 * caller short-circuits the empty case). Backs up before every edit, archives
 * (moves) the plist + state, writes the manifest, and returns the rollback
 * commands. Each item is independent, so a partial footprint applies cleanly.
 */
export async function executeMigration(
  fp: LegacyFootprint,
  deps: MigrateDeps,
): Promise<MigrationOutcome> {
  const ts = deps.now();
  const stamp = new Date(ts).toISOString().replace(/[:.]/g, '-');
  const archiveDir = path.join(deps.stateDir, 'migrate-archive', stamp);
  await fsp.mkdir(archiveDir, { recursive: true });

  const manifest: MigrationManifest = {
    version: 1,
    source: MIGRATION_SOURCE,
    migratedAt: ts,
    controlTowerDir: fp.controlTowerDir,
    launchAgents: [],
    stateArchive: [],
  };
  const rollback: string[] = [];

  // (a) settings.json — surgical hook removal (foreign hooks preserved).
  if (fp.hooks && fp.hooks.hits.length > 0) {
    const before = await readMaybe(fp.hooks.settingsPath);
    if (before !== null) {
      const backup = await writeVerbatimBackup(
        deps.stateDir,
        'migrate-claude',
        fp.hooks.settingsPath,
        before,
      );
      const settings = JSON.parse(before) as Settings;
      const stripped = stripControlTowerHooks(settings);
      const after = JSON.stringify(stripped, null, 2) + '\n';
      await atomicWrite(fp.hooks.settingsPath, after);
      manifest.settings = {
        path: fp.hooks.settingsPath,
        backup,
        removedHooks: fp.hooks.hits,
        shaBefore: contentSha(before),
        shaAfter: contentSha(after),
      };
      rollback.push(`cp ${q(backup)} ${q(fp.hooks.settingsPath)}`);
    }
  }

  // (b) codex notify — strip the wrapper, restoring the original tail verbatim.
  if (fp.codexNotify) {
    const before = await readMaybe(fp.codexNotify.configPath);
    if (before !== null) {
      const backup = await writeVerbatimBackup(
        deps.stateDir,
        'migrate-codex',
        fp.codexNotify.configPath,
        before,
      );
      const after = tomlArrayLineRemove(before, 'notify', fp.codexNotify.wrapperElement);
      await atomicWrite(fp.codexNotify.configPath, after);
      manifest.codexNotify = {
        path: fp.codexNotify.configPath,
        backup,
        wrapperElement: fp.codexNotify.wrapperElement,
        shaBefore: contentSha(before),
        shaAfter: contentSha(after),
      };
      rollback.push(`cp ${q(backup)} ${q(fp.codexNotify.configPath)}`);
    }
  }

  // (c) LaunchAgent(s) — bootout + move plist into the archive.
  for (const agent of fp.launchAgents) {
    const target = `gui/${deps.uid}/${agent.label}`;
    const res = await deps.launchctl(['bootout', target]).catch(() => ({
      code: 1,
      stdout: '',
      stderr: '',
    }));
    const archivedPath = path.join(archiveDir, 'launch-agents', path.basename(agent.plistPath));
    let sha = '';
    try {
      sha = contentSha(await fsp.readFile(agent.plistPath));
      await moveFile(agent.plistPath, archivedPath);
    } catch {
      /* plist vanished mid-run → nothing to move */
    }
    manifest.launchAgents.push({
      label: agent.label,
      originalPath: agent.plistPath,
      archivedPath,
      sha,
      bootout: { target, code: res.code },
    });
    rollback.push(
      `mv ${q(archivedPath)} ${q(agent.plistPath)} && launchctl bootstrap gui/${deps.uid} ${q(agent.plistPath)}`,
    );
  }

  // (d) events.jsonl + state store — MOVE into the archive with sha manifest.
  for (const file of fp.stateFiles.files) {
    const dest = path.join(archiveDir, 'state', path.basename(file.path));
    let sha = '';
    try {
      sha = contentSha(await fsp.readFile(file.path)); // Buffer sha; content never printed
      await moveFile(file.path, dest);
    } catch {
      continue; // raced away
    }
    manifest.stateArchive.push({ from: file.path, to: dest, sha });
    rollback.push(`mv ${q(dest)} ${q(file.path)}`);
  }

  const manifestPath = path.join(archiveDir, 'manifest.json');
  await atomicWrite(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  return { archiveDir, manifestPath, manifest, rollback };
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

/** `terminull migrate --from <source> [--execute] [--json]`. */
export async function runMigrate(
  values: { from?: string; execute?: boolean; json?: boolean },
  deps: MigrateDeps,
): Promise<number> {
  if (values.from !== MIGRATION_SOURCE) {
    deps.stderr(
      t('migrate.unknownSource', { source: values.from ?? '', supported: MIGRATION_SOURCE }),
    );
    return 2;
  }

  const fp = await detectLegacy(deps);

  if (values.json) {
    deps.stdout(JSON.stringify(fp, null, 2));
    return 0;
  }

  if (!fp.anyFound) {
    deps.stdout(t('migrate.nothing', { dir: fp.controlTowerDir }));
    return 0;
  }

  if (!values.execute) {
    for (const line of renderMigrationPlan(fp, { execute: false })) deps.stdout(line);
    return 0;
  }

  // --execute: apply, then print archive location, follow-ups, and rollback.
  for (const line of renderMigrationPlan(fp, { execute: true })) deps.stdout(line);
  const outcome = await executeMigration(fp, deps);
  deps.stdout('');
  deps.stdout(t('migrate.applied', { archive: outcome.archiveDir }));
  deps.stdout(t('migrate.manifest', { path: outcome.manifestPath }));
  if (fp.codexNotify) deps.stdout(t('migrate.followupInject'));
  deps.stdout('');
  deps.stdout(t('migrate.rollbackHeader'));
  for (const cmd of outcome.rollback) deps.stdout(`  ${cmd}`);
  return 0;
}
