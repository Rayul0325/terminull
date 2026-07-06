/**
 * Programmatic plugin-directory validator — the machine oracle of the plugin
 * authoring kit. `terminull plugins validate <dir>` wraps this; example
 * plugins and scaffold templates are tested against it; authoring docs tell
 * agents to loop on it until green.
 *
 * NODE-ONLY (`node:fs`/`node:path`): exposed via the `./validate` subpath so
 * the pure schema entry point stays web-bundle safe.
 *
 * Checks, in order (later checks still run when earlier ones fail, except
 * that schema-dependent checks need a schema-valid manifest):
 *  1. directory exists;
 *  2. a manifest is found — `terminull.plugin.json`, else a `terminull` field
 *     in `package.json`, else `package.json` itself — and parses as JSON;
 *  3. the manifest passes {@link PluginManifestSchema} (every zod issue is
 *     reported with its path — actionable, not just "invalid");
 *  4. `pluginApi` admits the host {@link PLUGIN_API_VERSION} (semver gate);
 *  5. every contribution `module` path stays INSIDE the plugin dir (jail) and
 *     exists as a file; `.json` modules must parse as JSON;
 *  6. contribution ids are unique per point within the manifest.
 *
 * Honesty: `ok` is true only when there are zero errors; advisory findings
 * (e.g. name not matching `terminull-plugin-*`) go to `warnings` and never
 * flip `ok`.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  CONTRIBUTION_POINTS,
  PLUGIN_API_VERSION,
  PluginManifestSchema,
  type PluginManifest,
} from './manifest.js';
import { rangeSatisfies } from './range.js';

/** Machine-readable validation issue codes. */
export const PLUGIN_VALIDATION_CODES = [
  'dir_not_found',
  'manifest_missing',
  'manifest_unparseable',
  'manifest_invalid',
  'plugin_api_incompatible',
  'module_path_escapes',
  'module_missing',
  'module_json_invalid',
  'duplicate_contribution_id',
] as const;
export type PluginValidationCode = (typeof PLUGIN_VALIDATION_CODES)[number];

/** One validation error/warning, with an actionable message. */
export interface PluginValidationIssue {
  code: PluginValidationCode | 'name_convention';
  /** English, actionable: what is wrong AND what to change. */
  message: string;
  /** Manifest path (`contributes.themes[0].module`) or file path when relevant. */
  at?: string;
}

/** Result of {@link validatePluginDir}. */
export interface PluginValidationResult {
  ok: boolean;
  /** Where the manifest was read from, when found. */
  manifestSource: 'terminull.plugin.json' | 'package.json#terminull' | 'package.json' | null;
  /** The schema-valid manifest, when parsing+schema succeeded (even if later checks failed). */
  manifest: PluginManifest | null;
  errors: PluginValidationIssue[];
  warnings: PluginValidationIssue[];
}

interface FoundManifest {
  source: NonNullable<PluginValidationResult['manifestSource']>;
  raw: unknown;
}

function readManifest(dir: string): FoundManifest | PluginValidationIssue {
  const direct = path.join(dir, 'terminull.plugin.json');
  const pkgPath = path.join(dir, 'package.json');
  if (fs.existsSync(direct)) {
    try {
      return { source: 'terminull.plugin.json', raw: JSON.parse(fs.readFileSync(direct, 'utf8')) };
    } catch (err) {
      return {
        code: 'manifest_unparseable',
        message: `terminull.plugin.json is not valid JSON: ${(err as Error).message}`,
        at: direct,
      };
    }
  }
  if (!fs.existsSync(pkgPath)) {
    return {
      code: 'manifest_missing',
      message:
        'no manifest found — add a terminull.plugin.json, or a "terminull" field in package.json',
      at: dir,
    };
  }
  let pkg: unknown;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch (err) {
    return {
      code: 'manifest_unparseable',
      message: `package.json is not valid JSON: ${(err as Error).message}`,
      at: pkgPath,
    };
  }
  if (pkg !== null && typeof pkg === 'object' && 'terminull' in pkg) {
    return { source: 'package.json#terminull', raw: (pkg as { terminull: unknown }).terminull };
  }
  return { source: 'package.json', raw: pkg };
}

/** True when `modulePath` resolved from `dir` stays inside `dir`. */
function insideDir(dir: string, modulePath: string): boolean {
  if (path.isAbsolute(modulePath)) return false;
  const abs = path.resolve(dir, modulePath);
  const rel = path.relative(path.resolve(dir), abs);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Validate one plugin directory. Pure fs reads; never writes. */
export function validatePluginDir(dir: string): PluginValidationResult {
  const errors: PluginValidationIssue[] = [];
  const warnings: PluginValidationIssue[] = [];
  const result = (
    manifestSource: PluginValidationResult['manifestSource'],
    manifest: PluginManifest | null,
  ): PluginValidationResult => ({
    ok: errors.length === 0,
    manifestSource,
    manifest,
    errors,
    warnings,
  });

  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    errors.push({
      code: 'dir_not_found',
      message: `plugin directory does not exist: ${dir}`,
      at: dir,
    });
    return result(null, null);
  }

  const found = readManifest(dir);
  if (!('source' in found)) {
    errors.push(found);
    return result(null, null);
  }

  const parsed = PluginManifestSchema.safeParse(found.raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push({
        code: 'manifest_invalid',
        message: `${issue.message} — fix the manifest field and re-run validate`,
        at: issue.path.join('.') || '(manifest root)',
      });
    }
    return result(found.source, null);
  }
  const manifest = parsed.data;

  if (!rangeSatisfies(manifest.pluginApi)) {
    errors.push({
      code: 'plugin_api_incompatible',
      message: `pluginApi range '${manifest.pluginApi}' does not admit host API v${PLUGIN_API_VERSION} — use e.g. '^${PLUGIN_API_VERSION}'`,
      at: 'pluginApi',
    });
  }

  if (!/^terminull-plugin-|^@[^/]+\/terminull-plugin-/.test(manifest.name)) {
    warnings.push({
      code: 'name_convention',
      message: `plugin name '${manifest.name}' does not follow the 'terminull-plugin-*' convention (advisory only)`,
      at: 'name',
    });
  }

  for (const point of CONTRIBUTION_POINTS) {
    const list = manifest.contributes[point] ?? [];
    const seen = new Set<string>();
    list.forEach((contribution, i) => {
      const at = `contributes.${point}[${i}]`;
      if (seen.has(contribution.id)) {
        errors.push({
          code: 'duplicate_contribution_id',
          message: `duplicate ${point} id '${contribution.id}' in this manifest — contribution ids must be unique per point`,
          at: `${at}.id`,
        });
      }
      seen.add(contribution.id);

      if (!insideDir(dir, contribution.module)) {
        errors.push({
          code: 'module_path_escapes',
          message: `module '${contribution.module}' must be a relative path inside the plugin directory`,
          at: `${at}.module`,
        });
        return;
      }
      const abs = path.resolve(dir, contribution.module);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        errors.push({
          code: 'module_missing',
          message: `module file '${contribution.module}' does not exist — create it or fix the path`,
          at: `${at}.module`,
        });
        return;
      }
      if (abs.endsWith('.json')) {
        try {
          JSON.parse(fs.readFileSync(abs, 'utf8'));
        } catch (err) {
          errors.push({
            code: 'module_json_invalid',
            message: `module '${contribution.module}' is not valid JSON: ${(err as Error).message}`,
            at: `${at}.module`,
          });
        }
      }
    });
  }

  return result(found.source, manifest);
}
