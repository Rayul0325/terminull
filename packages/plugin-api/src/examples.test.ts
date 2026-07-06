/**
 * Example-plugin gate (M10 gate (d)). The three reference plugins under
 * `examples/` must PASS {@link validatePluginDir} with zero errors; the
 * deliberately-broken fixture must FAIL with actionable, path-anchored errors.
 * Plus: the ja locale pack must mirror the core `en.json` key structure exactly.
 *
 * Examples are referenced BY PATH (they are not workspace members). Nothing is
 * written; no real home is touched.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validatePluginDir } from './validate.js';

const examplesDir = fileURLToPath(new URL('../../../examples', import.meta.url));
const enJsonPath = fileURLToPath(new URL('../../web/src/i18n/locales/en.json', import.meta.url));
const ex = (name: string): string => path.join(examplesDir, name);

/** All dotted leaf-key paths of a nested object (arrays treated as leaves). */
function flatKeys(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [prefix];
  const out: string[] = [];
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out.push(...flatKeys(v, prefix ? `${prefix}.${k}` : k));
  }
  return out;
}

const readJson = (p: string): unknown => JSON.parse(fs.readFileSync(p, 'utf8'));

describe('example plugins pass validate (gate d, positive half)', () => {
  it.each([
    ['terminull-plugin-obsidian-warm', 'themes', 'obsidian-warm'] as const,
    ['terminull-plugin-scratchpad', 'panels', 'scratchpad'] as const,
    ['terminull-plugin-locale-ja', 'locales', 'locale-ja'] as const,
  ])('%s validates clean with the expected contribution id', (dirName, point, id) => {
    const res = validatePluginDir(ex(dirName));
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
    // Examples deliberately follow the terminull-plugin-* name convention.
    expect(res.warnings).toEqual([]);
    expect(res.manifestSource).toBe('terminull.plugin.json');
    const list = res.manifest?.contributes[point];
    expect(list?.[0]?.id).toBe(id);
  });
});

describe('broken fixture fails actionably (gate d, negative half)', () => {
  it('reports a wrong-major pluginApi AND a missing module, each path-anchored', () => {
    const res = validatePluginDir(ex('terminull-plugin-broken'));
    expect(res.ok).toBe(false);

    const semver = res.errors.find((e) => e.code === 'plugin_api_incompatible');
    expect(semver?.at).toBe('pluginApi');
    expect(semver?.message).toContain("use e.g. '^1'");

    const missing = res.errors.find((e) => e.code === 'module_missing');
    expect(missing?.at).toBe('contributes.themes[0].module');
    expect(missing?.message).toMatch(/create it or fix the path/);
  });
});

describe('locale-ja pack ↔ core en.json parity', () => {
  it('ja.json contains exactly the en.json keys — no missing, no extra', () => {
    const en = readJson(enJsonPath);
    const ja = readJson(ex('terminull-plugin-locale-ja/ja.json'));
    const enKeys = flatKeys(en).sort();
    const jaKeys = flatKeys(ja).sort();
    // Point at the specific offenders if they ever diverge.
    expect(jaKeys.filter((k) => !enKeys.includes(k))).toEqual([]); // extra in ja
    expect(enKeys.filter((k) => !jaKeys.includes(k))).toEqual([]); // missing from ja
    expect(jaKeys).toEqual(enKeys);
  });

  it('preserves every {{interpolation}} token from en.json in ja.json', () => {
    const en = readJson(enJsonPath) as Record<string, unknown>;
    const ja = readJson(ex('terminull-plugin-locale-ja/ja.json')) as Record<string, unknown>;
    const tokensAt = (obj: unknown, keyPath: string): string[] => {
      const leaf = keyPath.split('.').reduce<unknown>((acc, k) => {
        return acc !== null && typeof acc === 'object'
          ? (acc as Record<string, unknown>)[k]
          : undefined;
      }, obj);
      return typeof leaf === 'string' ? [...leaf.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!) : [];
    };
    for (const keyPath of flatKeys(en)) {
      expect(tokensAt(ja, keyPath).sort(), `tokens for ${keyPath}`).toEqual(
        tokensAt(en, keyPath).sort(),
      );
    }
  });
});
