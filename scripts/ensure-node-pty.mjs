// Ensures node-pty is actually loadable after install. Two shipped-package traps:
//  1. darwin prebuilds contain a non-executable spawn-helper (mode 0644) →
//     every PTY spawn fails with `posix_spawnp failed` even though require works.
//     Fix: chmod 0755.
//  2. The npm tarball ships NO linux prebuild at all → `Cannot find module
//     './prebuilds/linux-x64/pty.node'`. Fix: compile from source via node-gyp.
// Runs as the root postinstall so fresh installs (dev machines, CI) self-heal.
import { execFileSync } from 'node:child_process';
import { globSync, chmodSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const pkgDirs = [
  ...globSync('node_modules/.pnpm/node-pty@*/node_modules/node-pty'),
  ...globSync('node_modules/node-pty'),
];

if (pkgDirs.length === 0) {
  console.log('[ensure-node-pty] node-pty not installed; nothing to do');
  process.exit(0);
}

const platformArch = `${process.platform}-${process.arch}`;

for (const dir of pkgDirs) {
  // Trap 1: make any shipped spawn-helper executable.
  for (const helper of globSync(join(dir, 'prebuilds/*/spawn-helper'))) {
    const mode = statSync(helper).mode & 0o777;
    if ((mode & 0o111) === 0) {
      chmodSync(helper, 0o755);
      console.log(`[ensure-node-pty] chmod 755 ${helper}`);
    }
  }

  // Trap 2: no usable native binary for this platform → compile from source.
  const built = join(dir, 'build/Release/pty.node');
  const prebuilt = join(dir, `prebuilds/${platformArch}/pty.node`);
  const prebuiltAlt = join(dir, `prebuilds/${platformArch}/node-pty.node`);
  if (existsSync(built) || existsSync(prebuilt) || existsSync(prebuiltAlt)) {
    console.log(`[ensure-node-pty] native binary present for ${platformArch} in ${dir}`);
    continue;
  }
  console.log(`[ensure-node-pty] no ${platformArch} binary in ${dir}; compiling with node-gyp...`);
  execFileSync('npx', ['--yes', 'node-gyp', 'rebuild'], {
    cwd: dir,
    stdio: 'inherit',
    env: { ...process.env, npm_config_build_from_source: 'true' },
  });
  if (!existsSync(built)) {
    console.error(`[ensure-node-pty] compile finished but ${built} is missing`);
    process.exit(1);
  }
  console.log(`[ensure-node-pty] compiled ${built}`);
}
