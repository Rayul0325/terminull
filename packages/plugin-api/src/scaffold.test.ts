/**
 * Scaffold → validate loop (M10 gate (e)). Every template the scaffolder emits
 * must pass {@link validatePluginDir} with zero errors the moment it is written.
 * All output goes to a fresh mkdtemp under os.tmpdir(); no real home is touched.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONTRIBUTION_POINTS } from './manifest.js';
import { FIRST_CLASS_POINTS, normalizeScaffoldPoint, scaffoldPlugin } from './scaffold.js';
import { validatePluginDir } from './validate.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-scaffold-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('scaffoldPlugin → validate (gate e)', () => {
  it('every one of the 8 contribution points scaffolds a validate-green package', () => {
    for (const point of CONTRIBUTION_POINTS) {
      const res = scaffoldPlugin({ point, name: `sample-${point.toLowerCase()}`, targetDir: dir });
      const validation = validatePluginDir(res.dir);
      expect(validation.errors, `${point} scaffold must validate clean`).toEqual([]);
      expect(validation.ok).toBe(true);
      // The manifest is read from the dedicated file, not package.json.
      expect(validation.manifestSource).toBe('terminull.plugin.json');
      // The declared module actually exists on disk.
      const mod = validation.manifest?.contributes[point]?.[0]?.module;
      expect(mod).toBeTruthy();
      expect(fs.existsSync(path.join(res.dir, mod!))).toBe(true);
    }
  });

  it('marks theme/panel/locale as first-class and the other five as generic', () => {
    const theme = scaffoldPlugin({ point: 'themes', name: 'my-theme', targetDir: dir });
    expect(theme.firstClass).toBe(true);
    const cmd = scaffoldPlugin({ point: 'commands', name: 'my-cmd', targetDir: dir });
    expect(cmd.firstClass).toBe(false);
    expect([...FIRST_CLASS_POINTS]).toEqual(['themes', 'panels', 'locales']);
  });

  it('writes a complete npm-shaped package (package.json + manifest + module + README + LICENSE)', () => {
    const res = scaffoldPlugin({ point: 'themes', name: 'obsidian', targetDir: dir });
    expect(res.files.sort()).toEqual(
      ['LICENSE', 'README.md', 'package.json', 'terminull.plugin.json', 'theme.json'].sort(),
    );
    const pkg = JSON.parse(fs.readFileSync(path.join(res.dir, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('terminull-plugin-obsidian');
    expect(pkg.license).toBe('MIT');
    expect(pkg.type).toBe('module');
  });

  it('normalizeScaffoldPoint accepts singular + plural, rejects garbage', () => {
    expect(normalizeScaffoldPoint('theme')).toBe('themes');
    expect(normalizeScaffoldPoint('themes')).toBe('themes');
    expect(normalizeScaffoldPoint('harnessForm')).toBe('harnessForms');
    expect(normalizeScaffoldPoint('banana')).toBeNull();
  });

  it('refuses an invalid slug and never clobbers an existing directory', () => {
    expect(() => scaffoldPlugin({ point: 'themes', name: 'Bad Name', targetDir: dir })).toThrow(
      /invalid plugin name/,
    );
    scaffoldPlugin({ point: 'themes', name: 'dup', targetDir: dir });
    expect(() => scaffoldPlugin({ point: 'themes', name: 'dup', targetDir: dir })).toThrow(
      /refusing to overwrite/,
    );
  });
});
