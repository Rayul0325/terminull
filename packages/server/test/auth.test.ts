/**
 * Unit tests for the auth primitives: originOk, actorOf, loopback trust and
 * the token file. Requests are faked as plain objects — no server needed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Auth, originOk } from '../src/auth';

let dir: string;
let auth: Auth;
let token: string;

function req(opts: {
  headers?: Record<string, string>;
  remoteAddress?: string;
}): http.IncomingMessage {
  return {
    headers: opts.headers ?? {},
    socket: { remoteAddress: opts.remoteAddress ?? '127.0.0.1' },
  } as unknown as http.IncomingMessage;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnull-auth-'));
  auth = new Auth({ stateDir: dir });
  token = fs.readFileSync(path.join(dir, 'token'), 'utf8').trim();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('token file', () => {
  it('is created 0600 with a non-trivial secret', () => {
    const stat = fs.statSync(path.join(dir, 'token'));
    expect(stat.mode & 0o777).toBe(0o600);
    expect(token.length).toBeGreaterThanOrEqual(32);
  });
});

describe('originOk', () => {
  it('allows requests without an Origin header (curl/hooks)', () => {
    expect(originOk(req({ headers: { host: 'localhost:7420' } }))).toBe(true);
  });

  it('allows a same-origin browser request', () => {
    expect(
      originOk(req({ headers: { host: 'localhost:7420', origin: 'http://localhost:7420' } })),
    ).toBe(true);
  });

  it('rejects a cross-origin request (CSWSH/CSRF)', () => {
    expect(
      originOk(req({ headers: { host: 'localhost:7420', origin: 'http://evil.example' } })),
    ).toBe(false);
  });

  it('rejects a malformed Origin', () => {
    expect(originOk(req({ headers: { host: 'localhost:7420', origin: '::not a url::' } }))).toBe(
      false,
    );
  });
});

describe('actorOf', () => {
  it('bearer token → user', () => {
    expect(auth.actorOf(req({ headers: { authorization: `Bearer ${token}` } }))).toBe('user');
  });

  it('enrolment cookie → user', () => {
    expect(auth.actorOf(req({ headers: { cookie: `terminull_token=${token}` } }))).toBe('user');
  });

  it('bare loopback is NEVER auto-promoted to user', () => {
    expect(auth.actorOf(req({ remoteAddress: '127.0.0.1' }))).toBe('unknown');
  });

  it('self-label binds an agent even when it also holds the token', () => {
    expect(
      auth.actorOf(
        req({
          headers: { authorization: `Bearer ${token}`, 'x-terminull-actor': 'agent' },
        }),
      ),
    ).toBe('agent');
  });

  it('self-label hook → hook', () => {
    expect(auth.actorOf(req({ headers: { 'x-terminull-actor': 'hook' } }))).toBe('hook');
  });

  it("self-label 'user' is not honored (no escalation path)", () => {
    expect(auth.actorOf(req({ headers: { 'x-terminull-actor': 'user' } }))).toBe('unknown');
  });

  it('a wrong bearer token is not a credential', () => {
    expect(auth.actorOf(req({ headers: { authorization: 'Bearer wrong' } }))).toBe('unknown');
  });
});

describe('authed', () => {
  it('trusts loopback by default', () => {
    expect(auth.authed(req({ remoteAddress: '127.0.0.1' }))).toBe(true);
  });

  it('rejects non-loopback without a credential', () => {
    expect(auth.authed(req({ remoteAddress: '203.0.113.7' }))).toBe(false);
  });

  it('accepts non-loopback with the bearer token', () => {
    expect(
      auth.authed(
        req({ remoteAddress: '203.0.113.7', headers: { authorization: `Bearer ${token}` } }),
      ),
    ).toBe(true);
  });

  it('trustLoopback=false requires a credential even locally', () => {
    const strict = new Auth({ stateDir: dir, trustLoopback: false });
    expect(strict.authed(req({ remoteAddress: '127.0.0.1' }))).toBe(false);
  });
});
