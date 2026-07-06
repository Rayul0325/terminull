/**
 * Static web-panel hosting: with a `uiDir` the server serves the built SPA
 * (hashed assets immutable-cached, deep links → index.html, traversal jailed);
 * without one it degrades to the honest smoke page. In-process HTTP on an
 * ephemeral port; the fake UI dir lives under os.tmpdir().
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startStack, type Stack } from './harness';

let stack: Stack;
let uiDir: string;

const INDEX_HTML =
  '<!doctype html><html><head>' +
  '<script type="module" src="/assets/index-abc123.js"></script>' +
  '</head><body><div id="root"></div></body></html>';

beforeAll(() => {
  uiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnull-ui-'));
  fs.mkdirSync(path.join(uiDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(uiDir, 'index.html'), INDEX_HTML);
  fs.writeFileSync(path.join(uiDir, 'assets', 'index-abc123.js'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(uiDir, 'assets', 'index-abc123.css'), '.a{color:red}\n');
  fs.writeFileSync(path.join(uiDir, 'popout.html'), '<!doctype html><body></body>');
  // A secret sitting OUTSIDE the jail — a traversal must never reach it.
  fs.writeFileSync(path.join(uiDir, '..', path.basename(uiDir) + '-SECRET'), 'top secret');
});

afterAll(() => {
  fs.rmSync(uiDir, { recursive: true, force: true });
  fs.rmSync(path.join(uiDir, '..', path.basename(uiDir) + '-SECRET'), { force: true });
});

afterEach(async () => {
  await stack.close();
});

describe('static web panel (uiDir present)', () => {
  it('serves the real index.html at / (not the smoke page)', async () => {
    stack = await startStack({ uiDir });
    const res = await fetch(`${stack.base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('id="root"');
    expect(html).toContain('/assets/index-abc123.js');
    // The smoke page's tell-tale must be gone.
    expect(html).not.toContain('/api/fleet');
  });

  it('serves a hashed asset with immutable caching + correct content-type', async () => {
    stack = await startStack({ uiDir });
    const js = await fetch(`${stack.base}/assets/index-abc123.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toContain('javascript');
    expect(js.headers.get('cache-control')).toContain('immutable');
    expect(await js.text()).toContain('export const x');

    const css = await fetch(`${stack.base}/assets/index-abc123.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toContain('text/css');
    expect(css.headers.get('cache-control')).toContain('immutable');
  });

  it('SPA-falls-back deep links to index.html with no-cache', async () => {
    stack = await startStack({ uiDir });
    for (const p of ['/workspace', '/settings', '/some/deep/link']) {
      const res = await fetch(`${stack.base}${p}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(res.headers.get('cache-control')).toContain('no-cache');
      expect(await res.text()).toContain('id="root"');
    }
  });

  it('serves non-hashed root files (popout.html) without immutable caching', async () => {
    stack = await startStack({ uiDir });
    const res = await fetch(`${stack.base}/popout.html`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cache-control')).not.toContain('immutable');
  });

  it('404s a missing hashed asset instead of SPA-falling-back to HTML', async () => {
    stack = await startStack({ uiDir });
    const res = await fetch(`${stack.base}/assets/missing-deadbeef.js`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect((await res.json()).code).toBe('not_found');
  });

  it('never intercepts an unknown /api/* GET (honest 404, not the SPA)', async () => {
    stack = await startStack({ uiDir });
    const res = await fetch(`${stack.base}/api/does-not-exist`);
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).not.toContain('id="root"');
    expect(JSON.parse(body).code).toBe('not_found');
  });

  it('jails path traversal — ../ escapes never read a file outside uiDir', async () => {
    stack = await startStack({ uiDir });
    const secretName = path.basename(uiDir) + '-SECRET';
    for (const attempt of [
      `/../${secretName}`,
      `/..%2f${secretName}`,
      `/%2e%2e/${secretName}`,
      `/assets/../../${secretName}`,
      '/../../../../../../etc/passwd',
    ]) {
      const res = await fetch(`${stack.base}${attempt}`);
      const text = await res.text();
      // Either a 404, or an SPA index.html fallback — NEVER the secret bytes.
      expect(text).not.toContain('top secret');
      expect(text).not.toContain('root:x:0:0');
    }
  });
});

describe('smoke fallback (uiDir absent)', () => {
  it('serves the smoke page at / and 404s non-root paths', async () => {
    stack = await startStack(); // no uiDir
    const root = await fetch(`${stack.base}/`);
    expect(root.status).toBe(200);
    const html = await root.text();
    expect(html).toContain('Terminull');
    expect(html).toContain('/api/fleet'); // the smoke page's fleet poller

    // Without a bundle there is no SPA — a client route is an honest 404.
    const deep = await fetch(`${stack.base}/workspace`);
    expect(deep.status).toBe(404);
    expect((await deep.json()).code).toBe('not_found');
  });

  it('treats a configured-but-missing uiDir as absent (smoke, not 500)', async () => {
    stack = await startStack({ uiDir: path.join(os.tmpdir(), 'tnull-nonexistent-ui-xyz') });
    const res = await fetch(`${stack.base}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Terminull');
  });
});
