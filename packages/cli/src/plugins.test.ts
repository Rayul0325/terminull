/**
 * `terminull plugins …` wrapper tests (gates (d) + (e) at the CLI layer):
 *  - scaffold → validate loop is GREEN for every first-class template,
 *  - validate FAILs a broken plugin dir with an actionable message + exit 1,
 *  - add copies a valid plugin into the state dir and records it, and REFUSES
 *    an invalid one.
 * All fs work happens in tmpdirs; no real home is touched.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runPluginsAdd, runPluginsScaffold, runPluginsValidate } from './plugins';

const tmpdirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-plug-'));
  tmpdirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tmpdirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function io(): {
  stdout: (l: string) => void;
  stderr: (l: string) => void;
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return { stdout: (l) => out.push(l), stderr: (l) => err.push(l), out, err };
}

describe('plugins scaffold → validate (gate e)', () => {
  for (const point of ['theme', 'panel', 'locale'] as const) {
    it(`scaffolds a ${point} plugin that immediately validates`, async () => {
      const target = tmp();
      const sink = io();
      const code = await runPluginsScaffold(point, 'demo', { ...sink, targetDir: target });
      expect(code).toBe(0);
      expect(sink.out.join('\n')).toMatch(/validated ✓|검증 통과/);
      // the written package really passes the standalone validator too
      const dir = path.join(target, 'terminull-plugin-demo');
      const check = io();
      expect(runPluginsValidate(dir, check)).toBe(0);
    });
  }

  it('rejects an unknown contribution point with exit 2', async () => {
    const sink = io();
    const code = await runPluginsScaffold('nonsense', 'demo', { ...sink, targetDir: tmp() });
    expect(code).toBe(2);
    expect(sink.err.join('\n')).toMatch(/unknown contribution point|알 수 없는 기여 지점/);
  });
});

describe('plugins validate (gate d negative half)', () => {
  it('FAILs a directory with no manifest, exit 1 + actionable message', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'readme.txt'), 'not a plugin');
    const sink = io();
    expect(runPluginsValidate(dir, sink)).toBe(1);
    expect(sink.err.join('\n')).toMatch(/manifest_missing|no manifest found/);
  });

  it('--json emits a machine-readable result', () => {
    const dir = tmp();
    const sink = io();
    runPluginsValidate(dir, { ...sink, json: true });
    const parsed = JSON.parse(sink.out.join('\n')) as { ok: boolean; errors: unknown[] };
    expect(parsed.ok).toBe(false);
    expect(Array.isArray(parsed.errors)).toBe(true);
  });
});

describe('plugins add', () => {
  it('copies a valid plugin into the state dir and records it', async () => {
    const target = tmp();
    await runPluginsScaffold('theme', 'warm', { ...io(), targetDir: target });
    const pluginDir = path.join(target, 'terminull-plugin-warm');

    const stateDir = tmp();
    const sink = io();
    const code = await runPluginsAdd(pluginDir, { ...sink, stateDir, now: () => 42 });
    expect(code).toBe(0);
    const dest = path.join(stateDir, 'plugins', 'terminull-plugin-warm');
    expect(fs.existsSync(path.join(dest, 'terminull.plugin.json'))).toBe(true);
    const registry = JSON.parse(fs.readFileSync(path.join(stateDir, 'plugins.json'), 'utf8')) as {
      plugins: { name: string; addedAt: number }[];
    };
    expect(registry.plugins[0]?.name).toBe('terminull-plugin-warm');
    expect(registry.plugins[0]?.addedAt).toBe(42);
  });

  it('refuses an invalid plugin dir (exit 1) and records nothing', async () => {
    const badDir = tmp();
    fs.writeFileSync(path.join(badDir, 'readme.txt'), 'nope');
    const stateDir = tmp();
    const sink = io();
    expect(await runPluginsAdd(badDir, { ...sink, stateDir })).toBe(1);
    expect(fs.existsSync(path.join(stateDir, 'plugins.json'))).toBe(false);
  });

  it('rejects a tarball path honestly (v0.x = dir only)', async () => {
    const tar = path.join(tmp(), 'plugin.tgz');
    fs.writeFileSync(tar, 'binary');
    const sink = io();
    expect(await runPluginsAdd(tar, { ...sink, stateDir: tmp() })).toBe(2);
    expect(sink.err.join('\n')).toMatch(
      /tarball install is not supported|tarball 설치를 지원하지 않습니다/,
    );
  });
});
