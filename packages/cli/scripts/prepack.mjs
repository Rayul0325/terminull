// prepack for the published `terminull` package (contract §D1).
//
// Produces the tarball payload ENTIRELY inside packages/cli under gitignored
// dirs, so `npm pack` never mutates the workspace (gate (f)):
//   - dist-pack/  : the single tsup bundle (all @terminull/* inlined)
//   - web-dist/   : a copy of packages/web/dist (panel UI assets)
// It NEVER runs an install, NEVER writes outside packages/cli, and NEVER edits
// package.json in place (the `files` + `bin` map do the shipping).
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliDir = dirname(dirname(fileURLToPath(import.meta.url))); // packages/cli

// 1. Bundle bin.ts (+ all workspace code) into dist-pack/.
execFileSync('npx', ['tsup'], { cwd: cliDir, stdio: 'inherit' });

// 1b. Harness scripts are DATA the adapters resolve via import.meta.url — which
// breaks once inlined into the bundle. Co-locate each adapter's harness dir at
// dist-pack/harness/<tool>/ so injection.ts can point the injectors there.
const HARNESS = { claude: 'adapters/claude/harness', codex: 'adapters/codex/harness' };
for (const [tool, rel] of Object.entries(HARNESS)) {
  const src = join(cliDir, '..', ...rel.split('/'));
  const dst = join(cliDir, 'dist-pack', 'harness', tool);
  rmSync(dst, { recursive: true, force: true });
  if (existsSync(src)) {
    cpSync(src, dst, { recursive: true });
    console.log(`[prepack] copied harness/${tool}`);
  } else {
    throw new Error(`[prepack] adapter harness missing: ${src} — cannot ship a working setup`);
  }
}

// 2. Copy the web UI assets (best-effort; warn, never fail the pack).
const webSrc = join(cliDir, '..', 'web', 'dist');
const webOut = join(cliDir, 'web-dist');
rmSync(webOut, { recursive: true, force: true });
if (existsSync(webSrc)) {
  cpSync(webSrc, webOut, { recursive: true });
  console.log('[prepack] copied web-dist');
} else {
  console.warn('[prepack] packages/web/dist missing — run `pnpm --filter @terminull/web build` first');
}

console.log('[prepack] done (dist-pack + web-dist ready inside packages/cli)');
