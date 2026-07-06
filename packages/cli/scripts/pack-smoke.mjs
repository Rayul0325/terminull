// Pack smoke + workspace-mutation regression check (contract §D1, gate (f)).
//
// Proves the M8 deploy-mutation trap is solved: `npm pack` (which runs prepack)
// must leave the git working tree unchanged w.r.t. the generated pack artifacts
// — they all live under gitignored dirs inside packages/cli. Then it extracts
// the tarball and runs `terminull --help` to prove the bundle actually loads.
//
// Usage: node scripts/pack-smoke.mjs   (exit 0 = pass, non-zero = fail)
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = join(cliDir, '..', '..');
const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', ...opts });

function fail(msg) {
  console.error(`✖ pack-smoke: ${msg}`);
  process.exit(1);
}

// The pack artifacts that MUST stay invisible to git.
const PACK_GLOBS = ['dist-pack', 'web-dist', 'scripts-pack', '.tgz'];

const before = sh('git', ['status', '--porcelain'], { cwd: repoRoot });

const dest = mkdtempSync(join(tmpdir(), 'tn-pack-'));
console.log(`· npm pack → ${dest}`);
const packOut = sh('npm', ['pack', '--pack-destination', dest], { cwd: cliDir });
const tgz = packOut.trim().split('\n').pop().trim();
const tgzPath = join(dest, tgz);
if (!existsSync(tgzPath)) fail(`tarball not produced (${tgzPath})`);

// Gate (f): git tree unchanged w.r.t. pack artifacts.
const after = sh('git', ['status', '--porcelain'], { cwd: repoRoot });
const beforeSet = new Set(before.split('\n'));
const newLines = after.split('\n').filter((l) => l && !beforeSet.has(l));
const leaked = newLines.filter((l) => PACK_GLOBS.some((g) => l.includes(g)));
if (leaked.length > 0) {
  fail(`npm pack mutated the tracked tree:\n${leaked.join('\n')}`);
}
console.log('✓ workspace git-clean after npm pack (pack artifacts are gitignored)');

// Extract + inspect the tarball.
const extract = mkdtempSync(join(tmpdir(), 'tn-extract-'));
sh('tar', ['-xzf', tgzPath, '-C', extract]);
const pkgDir = join(extract, 'package');
for (const rel of ['dist-pack/bin.js', 'scripts/ensure-node-pty.mjs', 'dist-pack/harness/claude', 'dist-pack/harness/codex']) {
  if (!existsSync(join(pkgDir, rel))) fail(`tarball missing ${rel}`);
}
console.log(`✓ tarball ships: ${readdirSync(pkgDir).join(', ')}`);

// Run the bundled bin. node-pty/ws/zod are ESM externals, so they must resolve
// via node_modules on the module path — a real `npm i terminull` installs them
// from the registry; offline, we borrow the workspace-installed copies by
// symlinking node_modules next to the extracted package.
symlinkSync(join(cliDir, 'node_modules'), join(pkgDir, 'node_modules'));
const help = sh('node', [join(pkgDir, 'dist-pack', 'bin.js'), '--help'], {
  env: { ...process.env, TERMINULL_LANG: 'en' },
});
if (!/terminull setup/.test(help)) fail('`terminull --help` did not list the setup command');
console.log('✓ bundled `terminull --help` runs and lists setup');

console.log('✓ pack-smoke PASSED');
