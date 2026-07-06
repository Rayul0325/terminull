/**
 * Publish-metadata + workspace-mutation-trap regression (gate (f), fast half).
 *
 * The full pack smoke (npm pack → git-clean → tarball → `terminull --help`)
 * lives in scripts/pack-smoke.mjs and the CI job. Here we deterministically
 * pin the invariants that KEEP the tree clean: every pack-output dir is
 * gitignored, `files`/`bin` ship the bundle, and the published runtime deps are
 * exactly the three contract externals.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const cliDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(path.join(cliDir, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
  bin: Record<string, string>;
  files: string[];
  dependencies: Record<string, string>;
  scripts: Record<string, string>;
  publishConfig?: { access?: string };
  engines?: { node?: string };
};

describe('publish metadata (terminull)', () => {
  it('is the public product entry with bundle bin + engines', () => {
    expect(pkg.name).toBe('terminull');
    // Shape, not a pinned number — releases bump this without editing tests.
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
    expect(pkg.bin.terminull).toBe('dist-pack/bin.js');
    expect(pkg.publishConfig?.access).toBe('public');
    expect(pkg.engines?.node).toBe('>=22');
  });

  it('ships the bundle + node-pty healer, nothing else', () => {
    expect(pkg.files).toEqual(
      expect.arrayContaining(['dist-pack', 'web-dist', 'scripts/ensure-node-pty.mjs', 'README.md']),
    );
    expect(fs.existsSync(path.join(cliDir, 'README.md'))).toBe(true);
    expect(fs.existsSync(path.join(cliDir, 'scripts', 'ensure-node-pty.mjs'))).toBe(true);
    expect(pkg.scripts.prepack).toContain('prepack.mjs');
    expect(pkg.scripts.postinstall).toContain('ensure-node-pty.mjs');
  });

  it('declares EXACTLY the three contract externals as runtime deps', () => {
    // Everything else (@terminull/*) is INLINED by tsup, so it must NOT appear.
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['node-pty', 'ws', 'zod']);
    expect(Object.keys(pkg.dependencies).some((d) => d.startsWith('@terminull/'))).toBe(false);
  });
});

describe('workspace-mutation trap (gate f)', () => {
  const checkIgnored = (rel: string): boolean => {
    try {
      const out = execFileSync('git', ['check-ignore', rel], {
        cwd: cliDir,
        encoding: 'utf8',
      });
      return out.trim().length > 0;
    } catch {
      return false; // git check-ignore exits 1 when NOT ignored
    }
  };

  it('every pack-output dir is gitignored, so npm pack cannot dirty the tree', () => {
    for (const dir of ['dist-pack', 'web-dist', 'scripts-pack']) {
      expect(checkIgnored(dir)).toBe(true);
    }
  });
});
