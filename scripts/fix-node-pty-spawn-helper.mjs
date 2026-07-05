// node-pty 1.1.0 ships its darwin prebuilds with a non-executable spawn-helper
// (mode 0644), which makes every PTY spawn fail with `posix_spawnp failed`
// even though require('node-pty') succeeds. A fresh install re-extracts the
// broken prebuild, so this runs as a root postinstall: chmod 0755 every
// prebuilt spawn-helper it can find. No-op on platforms/layouts without one.
import { globSync } from 'node:fs';
import { chmodSync, statSync } from 'node:fs';

const patterns = [
  'node_modules/.pnpm/node-pty@*/node_modules/node-pty/prebuilds/*/spawn-helper',
  'node_modules/node-pty/prebuilds/*/spawn-helper',
];

let fixed = 0;
for (const pattern of patterns) {
  for (const helper of globSync(pattern)) {
    const mode = statSync(helper).mode & 0o777;
    if ((mode & 0o111) === 0) {
      chmodSync(helper, 0o755);
      fixed += 1;
      console.log(`[fix-node-pty] chmod 755 ${helper}`);
    }
  }
}
if (fixed === 0) console.log('[fix-node-pty] nothing to fix');
