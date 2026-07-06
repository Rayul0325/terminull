/**
 * Small HTTP helpers for the panel server: JSON responses with machine-only
 * error codes, a bounded JSON body reader, a tiny `:param` router (deliberately
 * no express — zero new framework surface in the long-lived API layer), and a
 * deep secret-masking walk for free-text payload fields.
 */
import type http from 'node:http';
import { maskSecrets } from '@terminull/core';
import type { ApiError } from '@terminull/shared';

/** Default cap on request bodies (1 MiB) — hooks post small JSON events. */
export const MAX_BODY_BYTES = 1024 * 1024;

/** Write a JSON response. Every error body is an {@link ApiError}. */
export function json(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
  });
  res.end(data);
}

/** Shorthand for a machine-readable error response. */
export function fail(
  res: http.ServerResponse,
  status: number,
  code: string,
  extra: Record<string, unknown> = {},
): void {
  const body: ApiError = { code, ...extra };
  json(res, status, body);
}

/** Thrown by {@link readJsonBody} — carries the HTTP status + error code. */
export class BodyError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = 'BodyError';
  }
}

/** Read and parse a JSON request body, bounded by `limit` bytes. */
export function readJsonBody(req: http.IncomingMessage, limit = MAX_BODY_BYTES): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) {
        req.destroy();
        reject(new BodyError(413, 'payload_too_large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.trim().length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new BodyError(400, 'invalid_json'));
      }
    });
    req.on('error', () => reject(new BodyError(400, 'body_read_failed')));
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/** A matched route's path parameters (`:sid` → `params.sid`). */
export type RouteParams = Record<string, string>;

/** A route handler. May be async; the router catches rejections. */
export type RouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  params: RouteParams,
  url: URL,
) => void | Promise<void>;

interface Route {
  method: string;
  segments: string[];
  handler: RouteHandler;
}

/**
 * Minimal exact-segment router with `:param` captures. No wildcards, no
 * middleware — the route table IS the public API surface, kept greppable.
 */
export class Router {
  private readonly routes: Route[] = [];

  add(method: string, pattern: string, handler: RouteHandler): this {
    this.routes.push({
      method: method.toUpperCase(),
      segments: pattern.split('/').filter((s) => s.length > 0),
      handler,
    });
    return this;
  }

  /** Find a handler for the request, or null. */
  match(method: string, pathname: string): { handler: RouteHandler; params: RouteParams } | null {
    const parts = pathname.split('/').filter((s) => s.length > 0);
    for (const route of this.routes) {
      if (route.method !== method.toUpperCase()) continue;
      if (route.segments.length !== parts.length) continue;
      const params: RouteParams = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const seg = route.segments[i]!;
        const part = parts[i]!;
        if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(part);
        else if (seg !== part) {
          ok = false;
          break;
        }
      }
      if (ok) return { handler: route.handler, params };
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Deep secret masking
// ---------------------------------------------------------------------------

const MASK_MAX_DEPTH = 8;
const MASK_MAX_NODES = 2000;

/**
 * Apply {@link maskSecrets} to every string reachable in `value` (bounded
 * depth/nodes so a hostile payload cannot wedge the server). Non-string leaves
 * pass through untouched; anything past the bounds is dropped honestly rather
 * than passed unmasked.
 */
export function maskDeep(value: unknown): unknown {
  let nodes = 0;
  const walk = (v: unknown, depth: number): unknown => {
    if (nodes++ > MASK_MAX_NODES || depth > MASK_MAX_DEPTH) return '[TRUNCATED]';
    if (typeof v === 'string') return maskSecrets(v);
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        out[k] = walk(x, depth + 1);
      }
      return out;
    }
    return v;
  };
  return walk(value, 0);
}
