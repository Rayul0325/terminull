/**
 * Self-test: this example theme plugin passes the programmatic validator.
 * Run from a built monorepo: `node --test test.mjs` (imports the compiled
 * `@terminull/plugin-api` validator by relative path — examples are not
 * workspace members, so there is no bare-specifier resolution to rely on).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePluginDir } from '../../packages/plugin-api/dist/validate.js';

test('obsidian-warm theme plugin passes validate with zero errors', () => {
  const res = validatePluginDir(import.meta.dirname);
  assert.deepEqual(res.errors, []);
  assert.equal(res.ok, true);
  assert.equal(res.manifestSource, 'terminull.plugin.json');
  assert.equal(res.manifest.contributes.themes[0].id, 'obsidian-warm');
  assert.equal(res.manifest.contributes.themes[0].kind, 'dark');
});
