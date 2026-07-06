// Pack smoke + workspace-mutation regression check (contract §D1, gate (f)).
//
// Proves the M8 deploy-mutation trap is solved: `npm pack` (which runs prepack)
// must leave the git working tree unchanged w.r.t. the generated pack artifacts
// — they all live under gitignored dirs inside packages/cli. Then it extracts
// the tarball and runs `terminull --help` to prove the bundle actually loads.
//
// Usage: node scripts/pack-smoke.mjs   (exit 0 = pass, non-zero = fail)
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
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
for (const rel of [
  'dist-pack/bin.js',
  'scripts/ensure-node-pty.mjs',
  'dist-pack/harness/claude',
  'dist-pack/harness/codex',
  // The real web UI must ship, AND the smoke page must ship co-located with the
  // bundle so a degraded pack (no web-dist) still serves an honest `/` (no 500).
  'web-dist/index.html',
  'dist-pack/smoke/index.html',
]) {
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

// Boot the bundled server from the INSTALLED tarball and prove `GET /` serves
// the REAL web UI (not the smoke page): the published defect was that `serve`
// hosted only the M5 smoke page. This is the end-to-end guard against regressing.
await serveProof();

console.log('✓ pack-smoke PASSED');

/** Start `terminull serve` from the extracted tarball; assert the real UI. */
async function serveProof() {
  const stateDir = mkdtempSync(join(tmpdir(), 'tn-serve-'));
  const port = 8100 + Math.floor(Math.random() * 800);
  const base = `http://127.0.0.1:${port}`;
  console.log(`· booting bundled server on :${port}`);
  const child = spawn(
    'node',
    [join(pkgDir, 'dist-pack', 'bin.js'), 'serve', '--port', String(port), '--server-state', stateDir],
    { env: { ...process.env, TERMINULL_LANG: 'en' }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const stop = () => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    rmSync(stateDir, { recursive: true, force: true });
  };

  try {
    // Wait (bounded) for the server to answer health.
    let up = false;
    for (let i = 0; i < 100 && !up; i++) {
      try {
        const h = await fetch(`${base}/api/health`);
        up = h.ok;
      } catch {
        /* not listening yet */
      }
      if (!up) await new Promise((r) => setTimeout(r, 100));
    }
    if (!up) fail(`bundled server never answered /api/health:\n${out}`);

    // GET / → the real web UI (has #root + a hashed asset link), NOT the smoke page.
    const rootRes = await fetch(`${base}/`);
    const rootHtml = await rootRes.text();
    if (rootRes.status !== 200) fail(`GET / status ${rootRes.status}\n${out}`);
    if (!/id="root"/.test(rootHtml)) {
      fail(`GET / is not the web UI (no #root div):\n${rootHtml.slice(0, 300)}`);
    }
    if (/M6 웹 앱/.test(rootHtml)) fail('GET / served the smoke page, not the real web UI');
    const asset = rootHtml.match(/\/assets\/[^"']+\.js/);
    if (!asset) fail(`web UI index has no /assets/*.js link:\n${rootHtml.slice(0, 300)}`);

    // The hashed asset resolves 200, correct type, immutable cache.
    const assetRes = await fetch(`${base}${asset[0]}`);
    if (assetRes.status !== 200) fail(`asset ${asset[0]} → ${assetRes.status}`);
    if (!/javascript/.test(assetRes.headers.get('content-type') ?? '')) {
      fail(`asset ${asset[0]} wrong content-type: ${assetRes.headers.get('content-type')}`);
    }
    if (!/immutable/.test(assetRes.headers.get('cache-control') ?? '')) {
      fail(`asset ${asset[0]} not immutable-cached: ${assetRes.headers.get('cache-control')}`);
    }

    // SPA deep link → index.html (client routing survives a hard reload).
    const deep = await fetch(`${base}/workspace`);
    const deepHtml = await deep.text();
    if (deep.status !== 200 || !/id="root"/.test(deepHtml)) {
      fail(`SPA deep link /workspace not served (status ${deep.status})`);
    }

    // The honest log line names the packed UI dir.
    if (!/serving web UI from .*web-dist \(packed layout\)/.test(out)) {
      fail(`serve did not log the packed web UI dir:\n${out}`);
    }
    console.log('✓ bundled server serves the real web UI (index + hashed asset + SPA fallback)');
  } finally {
    stop();
  }
}
