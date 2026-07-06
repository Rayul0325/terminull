import { defineConfig } from 'tsup';

/**
 * Pack-time bundler for the published `terminull` package (contract §D1).
 *
 * The single `bin.ts` entry is bundled with EVERY `@terminull/*` workspace
 * import INLINED (`noExternal`), so the tarball carries no workspace layout and
 * `npx terminull` needs no monorepo. The ONLY runtime deps kept external are
 * the three real ones — `node-pty` (native, MUST stay external), `ws`, `zod` —
 * which become the published package's `dependencies`. Anything else appearing
 * here would be a new-runtime-dep contract change.
 *
 * Everything lands under `dist-pack/` INSIDE packages/cli (gitignored), so
 * `npm pack` never mutates the workspace (gate (f)).
 */
export default defineConfig({
  entry: { bin: 'src/bin.ts' },
  outDir: 'dist-pack',
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  bundle: true,
  splitting: false,
  clean: true,
  sourcemap: false,
  dts: false,
  noExternal: [/^@terminull\//],
  external: ['node-pty', 'ws', 'zod'],
});
