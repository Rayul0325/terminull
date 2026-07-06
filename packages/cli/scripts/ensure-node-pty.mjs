// Published-package node-pty healer (postinstall of `terminull`).
//
// Adapted from the monorepo-root scripts/ensure-node-pty.mjs: instead of
// globbing pnpm's node_modules layout, it resolves the ONE installed node-pty
// via `require.resolve('node-pty/package.json')` (npm/pnpm/yarn agnostic).
// Two shipped-package traps it heals:
//   1. darwin prebuilds ship a non-executable spawn-helper (0644) → every PTY
//      spawn fails with `posix_spawnp failed`. Fix: chmod 0755.
//   2. no native binary for this platform in the tarball → compile from source.
// A missing node-pty (nothing to heal) is a clean no-op, never a failure.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

let dir;
try {
  dir = dirname(require.resolve('node-pty/package.json'));
} catch {
  console.log('[ensure-node-pty] node-pty not installed; nothing to do');
  process.exit(0);
}

const platformArch = `${process.platform}-${process.arch}`;

// Trap 1: make any shipped spawn-helper executable.
const prebuildsDir = join(dir, 'prebuilds');
if (existsSync(prebuildsDir)) {
  for (const sub of readdirSync(prebuildsDir)) {
    const helper = join(prebuildsDir, sub, 'spawn-helper');
    if (!existsSync(helper)) continue;
    const mode = statSync(helper).mode & 0o777;
    if ((mode & 0o111) === 0) {
      chmodSync(helper, 0o755);
      console.log(`[ensure-node-pty] chmod 755 ${helper}`);
    }
  }
}

// Trap 2: no usable native binary for this platform → compile from source.
const built = join(dir, 'build/Release/pty.node');
const prebuilt = join(dir, `prebuilds/${platformArch}/pty.node`);
const prebuiltAlt = join(dir, `prebuilds/${platformArch}/node-pty.node`);
if (existsSync(built) || existsSync(prebuilt) || existsSync(prebuiltAlt)) {
  console.log(`[ensure-node-pty] native binary present for ${platformArch}`);
  process.exit(0);
}

console.log(`[ensure-node-pty] no ${platformArch} binary; compiling with node-gyp...`);
try {
  execFileSync('npx', ['--yes', 'node-gyp', 'rebuild'], {
    cwd: dir,
    stdio: 'inherit',
    env: { ...process.env, npm_config_build_from_source: 'true' },
  });
} catch (err) {
  console.error(`[ensure-node-pty] compile failed: ${err?.message ?? err}`);
  process.exit(1);
}
if (!existsSync(built)) {
  console.error(`[ensure-node-pty] compile finished but ${built} is missing`);
  process.exit(1);
}
console.log(`[ensure-node-pty] compiled ${built}`);
