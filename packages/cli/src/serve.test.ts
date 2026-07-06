/**
 * `resolveUiDir` picks the built web panel for BOTH shipping layouts (published
 * tarball `<pkg>/web-dist`, dev repo `packages/web/dist`) purely from a base
 * dir, so it is testable with fake trees and no real bundle.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveUiDir } from './serve.js';

let base: string;

function writeIndex(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<div id="root"></div>');
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'tnull-serve-'));
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('resolveUiDir', () => {
  it('finds the published-tarball layout: <bundle>/../web-dist', () => {
    // fromDir mimics `<pkg>/dist-pack` (where the tsup bundle runs).
    const fromDir = path.join(base, 'dist-pack');
    fs.mkdirSync(fromDir, { recursive: true });
    const webDist = path.join(base, 'web-dist');
    writeIndex(webDist);

    const ui = resolveUiDir(fromDir);
    expect(ui).not.toBeNull();
    expect(ui!.layout).toBe('packed');
    expect(ui!.dir).toBe(path.resolve(webDist));
  });

  it('finds the dev-repo layout: packages/web/dist two levels up', () => {
    // fromDir mimics `packages/cli/dist` (or /src) at runtime.
    const fromDir = path.join(base, 'cli', 'dist');
    fs.mkdirSync(fromDir, { recursive: true });
    const webDist = path.join(base, 'web', 'dist');
    writeIndex(webDist);

    const ui = resolveUiDir(fromDir);
    expect(ui).not.toBeNull();
    expect(ui!.layout).toBe('dev');
    expect(ui!.dir).toBe(path.resolve(webDist));
  });

  it('returns null when no bundle exists (→ smoke fallback)', () => {
    const fromDir = path.join(base, 'dist-pack');
    fs.mkdirSync(fromDir, { recursive: true });
    expect(resolveUiDir(fromDir)).toBeNull();
  });

  it('requires an index.html — an empty web-dist does not count', () => {
    const fromDir = path.join(base, 'dist-pack');
    fs.mkdirSync(fromDir, { recursive: true });
    fs.mkdirSync(path.join(base, 'web-dist'), { recursive: true }); // no index.html
    expect(resolveUiDir(fromDir)).toBeNull();
  });

  it('prefers the packed layout when both are present', () => {
    // fromDir = <base>/a/b → packed: <base>/a/web-dist ; dev: <base>/web/dist
    const fromDir = path.join(base, 'a', 'b');
    fs.mkdirSync(fromDir, { recursive: true });
    const packed = path.join(base, 'a', 'web-dist');
    const dev = path.join(base, 'web', 'dist');
    writeIndex(packed);
    writeIndex(dev);

    const ui = resolveUiDir(fromDir);
    expect(ui!.layout).toBe('packed');
    expect(ui!.dir).toBe(path.resolve(packed));
  });
});
