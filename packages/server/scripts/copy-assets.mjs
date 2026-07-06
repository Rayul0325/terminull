// Copy non-TS assets (the smoke page) into dist so the built server can serve
// them with the same `./smoke/index.html`-relative resolution as the source.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = path.join(pkgDir, 'src', 'smoke', 'index.html');
const outDir = path.join(pkgDir, 'dist', 'smoke');
fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(src, path.join(outDir, 'index.html'));
