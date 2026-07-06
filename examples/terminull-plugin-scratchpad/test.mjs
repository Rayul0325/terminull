/**
 * Self-test for the scratchpad panel plugin. Two assertions:
 *
 *  1. it passes the programmatic validator, and
 *  2. it DOGFOODS the real plugin runtime — the same `PluginHost` the server
 *     uses loads this directory and registers the panel contribution.
 *
 * Both import the compiled monorepo output by relative path (examples are not
 * workspace members). Run from a built monorepo: `node --test test.mjs`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePluginDir } from '../../packages/plugin-api/dist/validate.js';
import { PluginHost } from '../../packages/adapter-sdk/dist/plugin-host.js';

test('scratchpad panel plugin passes validate with zero errors', () => {
  const res = validatePluginDir(import.meta.dirname);
  assert.deepEqual(res.errors, []);
  assert.equal(res.ok, true);
  assert.equal(res.manifest.contributes.panels[0].id, 'scratchpad');
});

test('the real PluginHost loads the directory and registers the panel', async () => {
  const host = new PluginHost();
  const result = await host.loadFromDir(import.meta.dirname);
  assert.equal(result.ok, true, 'plugin should register cleanly');
  assert.equal(result.contributionsDisabled.length, 0, 'nothing should be disabled');

  const panels = host.contributions('panels');
  assert.equal(panels.length, 1);
  assert.equal(panels[0].id, 'scratchpad');
  assert.equal(panels[0].pluginName, 'terminull-plugin-scratchpad');
  assert.equal(host.disabled().length, 0);
});
