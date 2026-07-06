/**
 * Plugin-API contract seed tests (M10) — pin the semver gate and the
 * programmatic validator that `terminull plugins validate` wraps. Every
 * directory fixture lives in a fresh mkdtemp under os.tmpdir(); nothing
 * touches any real home.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PLUGIN_API_VERSION, PluginManifestSchema } from './manifest.js';
import { rangeSatisfies } from './range.js';
import { validatePluginDir } from './validate.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-plugin-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeManifest(manifest: unknown): void {
  fs.writeFileSync(path.join(dir, 'terminull.plugin.json'), JSON.stringify(manifest, null, 2));
}

const validTheme = {
  name: 'terminull-plugin-obsidian-warm',
  version: '0.1.0',
  pluginApi: `^${PLUGIN_API_VERSION}`,
  contributes: {
    themes: [
      {
        id: 'obsidian-warm',
        module: './theme.json',
        label: { en: 'Obsidian Warm', ko: '흑요석 웜' },
        kind: 'dark',
      },
    ],
  },
};

describe('rangeSatisfies (the semver gate authors + runtime share)', () => {
  it('admits caret/exact/comparator ranges over the current API version', () => {
    expect(rangeSatisfies(`^${PLUGIN_API_VERSION}`)).toBe(true);
    expect(rangeSatisfies(`${PLUGIN_API_VERSION}`)).toBe(true);
    expect(rangeSatisfies(`>=${PLUGIN_API_VERSION} <${PLUGIN_API_VERSION + 1}`)).toBe(true);
  });
  it('fails closed: wrong major, garbage, empty', () => {
    expect(rangeSatisfies(`^${PLUGIN_API_VERSION + 1}`)).toBe(false);
    expect(rangeSatisfies('banana')).toBe(false);
    expect(rangeSatisfies('')).toBe(false);
  });
});

describe('PluginManifestSchema i18n rule', () => {
  it('rejects a label missing the ko locale', () => {
    const bad = structuredClone(validTheme) as typeof validTheme;
    // @ts-expect-error — deliberately dropping the mandatory ko label
    delete bad.contributes.themes[0].label.ko;
    expect(PluginManifestSchema.safeParse(bad).success).toBe(false);
  });
});

describe('validatePluginDir', () => {
  it('PASSES a minimal valid theme plugin (terminull.plugin.json + module file)', () => {
    writeManifest(validTheme);
    fs.writeFileSync(path.join(dir, 'theme.json'), JSON.stringify({ colors: {} }));
    const res = validatePluginDir(dir);
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
    expect(res.manifestSource).toBe('terminull.plugin.json');
    expect(res.manifest?.name).toBe('terminull-plugin-obsidian-warm');
  });

  it('FAILS a wrong-major pluginApi with an actionable message', () => {
    writeManifest({ ...validTheme, pluginApi: `^${PLUGIN_API_VERSION + 1}` });
    fs.writeFileSync(path.join(dir, 'theme.json'), '{}');
    const res = validatePluginDir(dir);
    expect(res.ok).toBe(false);
    const err = res.errors.find((e) => e.code === 'plugin_api_incompatible');
    expect(err?.message).toContain(`use e.g. '^${PLUGIN_API_VERSION}'`);
  });

  it('FAILS a module path escaping the plugin dir (jail)', () => {
    const bad = structuredClone(validTheme) as typeof validTheme;
    bad.contributes.themes[0]!.module = '../outside.json';
    writeManifest(bad);
    const res = validatePluginDir(dir);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.code === 'module_path_escapes')).toBe(true);
  });

  it('FAILS a missing module file, pointing at the exact manifest path', () => {
    writeManifest(validTheme); // theme.json never written
    const res = validatePluginDir(dir);
    expect(res.ok).toBe(false);
    const err = res.errors.find((e) => e.code === 'module_missing');
    expect(err?.at).toBe('contributes.themes[0].module');
  });

  it('FAILS schema-invalid manifests with per-field zod paths (not just "invalid")', () => {
    writeManifest({ name: 'x', version: '0.1.0' }); // pluginApi + contributes missing
    const res = validatePluginDir(dir);
    expect(res.ok).toBe(false);
    expect(res.errors.every((e) => e.code === 'manifest_invalid')).toBe(true);
    expect(res.errors.map((e) => e.at)).toEqual(
      expect.arrayContaining(['pluginApi', 'contributes']),
    );
  });

  it('reports manifest_missing for an empty dir and dir_not_found for a bogus path', () => {
    expect(validatePluginDir(dir).errors[0]?.code).toBe('manifest_missing');
    expect(validatePluginDir(path.join(dir, 'nope')).errors[0]?.code).toBe('dir_not_found');
  });

  it('warns (never fails) on the name convention', () => {
    writeManifest({ ...validTheme, name: 'my-cool-theme' });
    fs.writeFileSync(path.join(dir, 'theme.json'), '{}');
    const res = validatePluginDir(dir);
    expect(res.ok).toBe(true);
    expect(res.warnings.some((w) => w.code === 'name_convention')).toBe(true);
  });

  it('detects duplicate contribution ids within a point', () => {
    const dup = structuredClone(validTheme) as typeof validTheme;
    dup.contributes.themes.push({ ...dup.contributes.themes[0]! });
    writeManifest(dup);
    fs.writeFileSync(path.join(dir, 'theme.json'), '{}');
    const res = validatePluginDir(dir);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.code === 'duplicate_contribution_id')).toBe(true);
  });
});
