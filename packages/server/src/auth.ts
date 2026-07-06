/**
 * Auth + actor classification — a TS port of the proven control-tower model.
 *
 * Three independent checks, applied per request:
 *
 *  - `authed(req)`  — may this request talk to the server at all? Loopback is
 *    trusted by default (configurable); everything else needs the bearer token
 *    or the enrolment cookie.
 *  - `originOk(req)` — same-origin check on WS upgrades and state-changing
 *    requests. A malicious page in the user's browser IS loopback (so `authed`
 *    passes) but carries its own `Origin`; hooks/curl send none and pass.
 *    Defends against CSWSH + CSRF.
 *  - `actorOf(req)` — who is acting, for permission gating. `user` requires a
 *    POSITIVE credential (cookie or bearer); a self-label header lets agents
 *    and hooks bind themselves to their (stricter) permission class; a bare
 *    loopback request is `'unknown'`, NEVER silently promoted to user.
 *
 * The actor signal is honest-by-construction but not a hard boundary against a
 * local same-uid process (which could read the 0600 token file) — the boundary
 * it enforces is "nothing becomes `user` without presenting the credential".
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type http from 'node:http';
import type { Actor } from '@terminull/shared';

/** Cookie set by `GET /auth?token=` enrolment. */
export const TOKEN_COOKIE = 'terminull_token';
/** Self-label header for agents/hooks (values: 'agent' | 'hook'). */
export const ACTOR_HEADER = 'x-terminull-actor';

/** `Actor` plus the honest "no positive signal" classification. */
export type RequestActor = Actor | 'unknown';

/** Options for {@link Auth}. */
export interface AuthOptions {
  /** State dir holding the `token` file (created 0600 on first boot). */
  stateDir: string;
  /** Trust loopback for `authed()` (default true). Never affects `actorOf`. */
  trustLoopback?: boolean;
}

function timingSafeEq(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function cookieValue(req: http.IncomingMessage, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq) === name) return part.slice(eq + 1);
  }
  return null;
}

/**
 * Same-origin check for WS upgrades + state-changing requests. Non-browser
 * clients (hooks, curl) send no Origin and are allowed; a browser request must
 * carry an Origin whose host equals our Host header.
 */
export function originOk(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === (req.headers.host ?? '');
  } catch {
    return false;
  }
}

/** True when the TCP peer is a loopback address. */
export function isLoopback(req: http.IncomingMessage): boolean {
  const a = req.socket.remoteAddress ?? '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

export class Auth {
  readonly tokenFile: string;
  readonly trustLoopback: boolean;
  private readonly token: string;

  constructor(opts: AuthOptions) {
    this.trustLoopback = opts.trustLoopback ?? true;
    this.tokenFile = path.join(opts.stateDir, 'token');
    fs.mkdirSync(opts.stateDir, { recursive: true });
    if (!fs.existsSync(this.tokenFile)) {
      fs.writeFileSync(this.tokenFile, crypto.randomBytes(24).toString('hex'), {
        mode: 0o600,
      });
    }
    this.token = fs.readFileSync(this.tokenFile, 'utf8').trim();
  }

  /** Timing-safe comparison against the server token (for `/auth` enrolment). */
  tokenMatches(candidate: string): boolean {
    return candidate.length > 0 && timingSafeEq(candidate, this.token);
  }

  /** Does the request carry the bearer token or the enrolment cookie? */
  private hasCredential(req: http.IncomingMessage): boolean {
    const bearer = req.headers.authorization ?? '';
    if (bearer.startsWith('Bearer ') && this.tokenMatches(bearer.slice(7))) return true;
    const cookie = cookieValue(req, TOKEN_COOKIE);
    return cookie !== null && this.tokenMatches(cookie);
  }

  /** May this request talk to the server at all? */
  authed(req: http.IncomingMessage): boolean {
    if (this.trustLoopback && isLoopback(req)) return true;
    return this.hasCredential(req);
  }

  /**
   * Classify the caller. Self-label wins over credentials on purpose: an agent
   * that somehow holds the token still binds itself to the agent class when it
   * self-identifies. A label other than agent/hook is ignored (never a
   * privilege escalation path), and a bare loopback is `'unknown'`.
   */
  actorOf(req: http.IncomingMessage): RequestActor {
    const label = req.headers[ACTOR_HEADER];
    const labelValue = Array.isArray(label) ? label[0] : label;
    if (labelValue === 'agent' || labelValue === 'hook') return labelValue;
    if (this.hasCredential(req)) return 'user';
    return 'unknown';
  }
}
