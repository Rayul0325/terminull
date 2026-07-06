/**
 * Self-test for the Japanese locale plugin: it passes the programmatic
 * validator and declares the `ja` locale. The heavier assertion — that
 * `ja.json` mirrors the core `en.json` key structure exactly — lives in the
 * plugin-api suite (`packages/plugin-api/src/examples.test.ts`), which can read
 * the web app's `en.json`. Run from a built monorepo: `node --test test.mjs`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePluginDir } from '../../packages/plugin-api/dist/validate.js';

test('locale-ja plugin passes validate with zero errors', () => {
  const res = validatePluginDir(import.meta.dirname);
  assert.deepEqual(res.errors, []);
  assert.equal(res.ok, true);
  assert.equal(res.manifest.contributes.locales[0].id, 'locale-ja');
  assert.equal(res.manifest.contributes.locales[0].locale, 'ja');
});
