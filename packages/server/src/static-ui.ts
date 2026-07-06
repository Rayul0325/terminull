/**
 * Static hosting for the built web panel (the SPA). The panel server IS the
 * web-bundle host (desktop-shell design intent): it serves hashed `/assets/*`
 * with immutable caching, serves other real files (index.html, popout.html)
 * with revalidation, and falls back to index.html for client-routed deep links
 * (`/workspace`, `/settings`, …) so a hard reload / bookmarked URL still boots
 * the app. When no UI bundle is configured (or one is configured but missing),
 * it degrades HONESTLY to the M5-era smoke page at `/`.
 *
 * Security invariants:
 *  - every filesystem path is jailed to `uiDir` (path-traversal guard);
 *  - the API/WS/auth namespaces are NEVER intercepted — an unmatched `/api/*`,
 *    `/ws`, `/pty`, or `/auth` GET must 404, never leak the SPA;
 *  - a missing hashed asset 404s (never SPA-falls-back a `.js`/`.css`), so a
 *    deploy/asset drift surfaces instead of silently serving stale HTML.
 */
import fs from 'node:fs';
import path from 'node:path';
import type http from 'node:http';
import { fail } from './http-util.js';

/** Content types by extension. Anything unlisted → octet-stream. */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
};

/** Namespaces the static host must never intercept (honest 404 on a miss). */
const RESERVED_PREFIXES = ['/api', '/ws', '/pty', '/auth'];

/** Vite emits content-hashed files under `/assets/` — safe to cache forever. */
const IMMUTABLE = 'public, max-age=31536000, immutable';
/** index.html + non-hashed files must revalidate so a new deploy is picked up. */
const REVALIDATE = 'no-cache';

function isReserved(pathname: string): boolean {
  return RESERVED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/** True when the last path segment carries a file extension (…/foo.js). */
function hasExtension(pathname: string): boolean {
  const last = pathname.split('/').pop() ?? '';
  return /\.[a-zA-Z0-9]+$/.test(last);
}

export interface StaticUiOptions {
  /** The built web-bundle dir (absolute). Absent/missing → smoke fallback. */
  uiDir?: string;
  /** Absolute path to the smoke page (the honest fallback). */
  smokePath: string;
}

export class StaticUi {
  /** null when no usable bundle is present (→ smoke fallback). */
  private readonly uiDir: string | null;
  private readonly smokePath: string;

  constructor(opts: StaticUiOptions) {
    // Treat a configured-but-missing bundle as absent: the smoke page is the
    // honest fallback, never a 500. A dir only counts if it holds index.html.
    const resolved = opts.uiDir ? path.resolve(opts.uiDir) : null;
    this.uiDir = resolved && fs.existsSync(path.join(resolved, 'index.html')) ? resolved : null;
    this.smokePath = opts.smokePath;
  }

  /** True when a real UI bundle is being served (vs the smoke fallback). */
  get hasBundle(): boolean {
    return this.uiDir !== null;
  }

  /**
   * Serve a GET/HEAD request for a non-routed path. Returns true when it wrote
   * a response; false → the caller should emit its own 404 (missing asset,
   * reserved-namespace miss, or no bundle for a non-root path).
   */
  serve(res: http.ServerResponse, pathname: string, method: string): boolean {
    if (isReserved(pathname)) return false;

    if (this.uiDir === null) {
      // No bundle: the smoke page is the honest fallback, at '/' only.
      if (pathname === '/') return this.sendSmoke(res, method);
      return false;
    }

    // Bundle present: serve a real file if one exists inside the jail.
    const filePath = this.resolveInJail(pathname);
    if (filePath !== null && this.isFile(filePath)) {
      const cache = pathname.startsWith('/assets/') ? IMMUTABLE : REVALIDATE;
      return this.sendFile(res, filePath, method, cache);
    }
    // A miss on an extension-bearing path is a missing asset → honest 404
    // (never SPA-fall-back a .js/.css/.png; that would hide deploy drift).
    if (hasExtension(pathname)) return false;
    // Otherwise it's a client route (/workspace, deep link) → index.html.
    const index = path.join(this.uiDir, 'index.html');
    if (this.isFile(index)) return this.sendFile(res, index, method, REVALIDATE);
    return false;
  }

  /** Resolve `pathname` under uiDir, or null on traversal / bad encoding. */
  private resolveInJail(pathname: string): string | null {
    if (this.uiDir === null) return null;
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return null; // malformed %-encoding
    }
    if (decoded.includes('\0')) return null;
    const rel = decoded.startsWith('/') ? decoded : `/${decoded}`;
    const full = path.resolve(this.uiDir, `.${rel}`);
    // Jail: the resolved path must be the root itself or strictly inside it.
    if (full !== this.uiDir && !full.startsWith(this.uiDir + path.sep)) return null;
    return full;
  }

  private isFile(p: string): boolean {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  }

  private sendFile(
    res: http.ServerResponse,
    filePath: string,
    method: string,
    cacheControl: string,
  ): boolean {
    let body: Buffer;
    try {
      body = fs.readFileSync(filePath);
    } catch {
      return false;
    }
    res.writeHead(200, {
      'content-type': contentTypeFor(filePath),
      'content-length': body.length,
      'cache-control': cacheControl,
    });
    if (method === 'HEAD') res.end();
    else res.end(body);
    return true;
  }

  private sendSmoke(res: http.ServerResponse, method: string): boolean {
    let html: string;
    try {
      html = fs.readFileSync(this.smokePath, 'utf8');
    } catch {
      fail(res, 500, 'smoke_page_missing');
      return true;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (method === 'HEAD') res.end();
    else res.end(html);
    return true;
  }
}
