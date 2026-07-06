/**
 * `terminull plugins …` — THIN wrappers over the FROZEN `@terminull/plugin-api`
 * surface (contract §D4). No plugin logic lives here: validation is
 * `validatePluginDir`, scaffolding is `scaffoldPlugin`, and every scaffold is
 * re-validated the moment it is written (gate (e) — templates can never drift
 * out of validity).
 *
 * `add` copies a plugin dir into `<stateDir>/plugins/`, validates it, and
 * records it in `<stateDir>/plugins.json`; runtime loading beyond the existing
 * plugin-host is OUT OF SCOPE for v0.x (honest).
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { normalizeScaffoldPoint, scaffoldPlugin } from '@terminull/plugin-api/scaffold';
import { type PluginValidationResult, validatePluginDir } from '@terminull/plugin-api/validate';
import { t } from './messages.js';

interface Io {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

function printResult(result: PluginValidationResult, io: Io, asJson: boolean): void {
  if (asJson) {
    io.stdout(JSON.stringify(result, null, 2));
    return;
  }
  for (const issue of result.errors) {
    io.stderr(`  ✖ [${issue.code}] ${issue.message}${issue.at ? ` (at ${issue.at})` : ''}`);
  }
  for (const issue of result.warnings) {
    io.stdout(`  ⚠ [${issue.code}] ${issue.message}${issue.at ? ` (at ${issue.at})` : ''}`);
  }
}

/** `terminull plugins validate <dir> [--json]` → exit 1 on any error. */
export function runPluginsValidate(dir: string, opts: Io & { json?: boolean }): number {
  const result = validatePluginDir(path.resolve(dir));
  if (opts.json) {
    opts.stdout(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }
  if (result.ok) {
    opts.stdout(t('plugins.validateOk', { dir }));
    printResult(result, opts, false); // surfaces warnings (e.g. name convention)
    return 0;
  }
  opts.stderr(t('plugins.validateFail', { dir }));
  printResult(result, opts, false);
  return 1;
}

/** `terminull plugins scaffold <point> <name> [--dir <targetDir>]`. */
export async function runPluginsScaffold(
  point: string,
  name: string,
  opts: Io & { targetDir: string },
): Promise<number> {
  const normalized = normalizeScaffoldPoint(point);
  if (!normalized) {
    opts.stderr(t('plugins.scaffoldBadPoint', { point }));
    return 2;
  }
  let result;
  try {
    result = scaffoldPlugin({ point: normalized, name, targetDir: opts.targetDir });
  } catch (err) {
    opts.stderr(t('plugins.scaffoldFailed', { detail: (err as Error).message }));
    return 1;
  }
  opts.stdout(t('plugins.scaffolded', { dir: result.dir, count: result.files.length }));
  for (const f of result.files) opts.stdout(`  + ${f}`);

  // Gate (e): the scaffold MUST validate the instant it is written.
  const check = validatePluginDir(result.dir);
  if (!check.ok) {
    opts.stderr(t('plugins.scaffoldInvalid'));
    printResult(check, opts, false);
    return 1;
  }
  opts.stdout(t('plugins.scaffoldValidated'));
  return 0;
}

/** `<stateDir>/plugins.json` — the installed-plugin registry. */
interface PluginsRegistryEntry {
  name: string;
  point: string[];
  dir: string;
  addedAt: number;
}

async function readRegistry(file: string): Promise<PluginsRegistryEntry[]> {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as { plugins?: PluginsRegistryEntry[] };
    return Array.isArray(parsed.plugins) ? parsed.plugins : [];
  } catch {
    return [];
  }
}

async function copyDir(src: string, dst: string): Promise<void> {
  await fsp.cp(src, dst, { recursive: true });
}

/** `terminull plugins add <dir> [--server-state <dir>]`. */
export async function runPluginsAdd(
  source: string,
  opts: Io & { stateDir: string; now?: () => number },
): Promise<number> {
  const abs = path.resolve(source);
  let stat;
  try {
    stat = await fsp.stat(abs);
  } catch {
    opts.stderr(t('plugins.addNotFound', { source }));
    return 1;
  }
  if (!stat.isDirectory()) {
    // Tarball install is not in the v0.x scope — say so, don't fake it.
    opts.stderr(t('plugins.addNotDir', { source }));
    return 2;
  }

  const preflight = validatePluginDir(abs);
  if (!preflight.ok) {
    opts.stderr(t('plugins.addInvalid', { source }));
    printResult(preflight, opts, false);
    return 1;
  }
  const name = preflight.manifest?.name ?? path.basename(abs);
  const pluginsDir = path.join(opts.stateDir, 'plugins');
  const dest = path.join(pluginsDir, name);
  await fsp.mkdir(pluginsDir, { recursive: true });
  await fsp.rm(dest, { recursive: true, force: true });
  await copyDir(abs, dest);

  // Re-validate the COPY (path escapes are relative to the new location).
  const post = validatePluginDir(dest);
  if (!post.ok) {
    await fsp.rm(dest, { recursive: true, force: true });
    opts.stderr(t('plugins.addInvalid', { source }));
    printResult(post, opts, false);
    return 1;
  }

  const registryFile = path.join(opts.stateDir, 'plugins.json');
  const registry = (await readRegistry(registryFile)).filter((p) => p.name !== name);
  registry.push({
    name,
    point: Object.keys(post.manifest?.contributes ?? {}),
    dir: dest,
    addedAt: (opts.now ?? Date.now)(),
  });
  const tmp = `${registryFile}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, JSON.stringify({ version: 1, plugins: registry }, null, 2) + '\n', {
    mode: 0o600,
  });
  await fsp.rename(tmp, registryFile);

  opts.stdout(t('plugins.added', { name, dir: dest }));
  return 0;
}
