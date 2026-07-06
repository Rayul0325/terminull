/**
 * Test harness: a REAL SessionHost on a tmpdir socket + a TerminullServer on
 * an ephemeral port. Nothing touches the real ~/.claude or ~/.terminull —
 * every path lives under os.tmpdir() (short prefix: macOS caps AF_UNIX socket
 * paths at 104 bytes).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionHost } from '@terminull/session-host';
import { createTerminullServer, type ServerOptions, type TerminullServer } from '../src/index';

export interface Stack {
  stateDir: string;
  /** Fixture home handed to adapter collectors (empty unless a test fills it). */
  collectHome: string;
  host: SessionHost;
  server: TerminullServer;
  port: number;
  /** The server bearer token (positive `user` credential). */
  token: string;
  base: string;
  close(): Promise<void>;
}

/** Per-action permission overrides written to permissions.json before boot. */
export type PermissionOverrides = Record<string, 'autonomous' | 'confirm' | 'forbidden'>;

export async function startStack(
  opts: Partial<ServerOptions> & { permissions?: PermissionOverrides } = {},
): Promise<Stack> {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnull-'));
  const hostDir = path.join(stateDir, 'host');
  const collectHome = path.join(stateDir, 'home');
  fs.mkdirSync(collectHome, { recursive: true });

  const { permissions, ...serverOpts } = opts;
  if (permissions) {
    fs.writeFileSync(
      path.join(stateDir, 'permissions.json'),
      JSON.stringify({ version: 1, actions: permissions }),
    );
  }

  const host = new SessionHost({ stateDir: hostDir });
  await host.start();
  const server = createTerminullServer({
    stateDir,
    port: 0,
    hostStateDir: hostDir,
    spawnPaneldIfDead: false,
    collectHome,
    fleetTtlMs: 0,
    ...serverOpts,
  });
  const { port } = await server.listen();
  const token = fs.readFileSync(path.join(stateDir, 'token'), 'utf8').trim();

  return {
    stateDir,
    collectHome,
    host,
    server,
    port,
    token,
    base: `http://127.0.0.1:${port}`,
    close: async () => {
      await server.close();
      host.stop();
      fs.rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

/** fetch JSON with optional bearer/actor headers. */
export async function api(
  stack: Stack,
  method: string,
  pathname: string,
  opts: { body?: unknown; user?: boolean; actor?: string; origin?: string } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.user) headers['authorization'] = `Bearer ${stack.token}`;
  if (opts.actor) headers['x-terminull-actor'] = opts.actor;
  if (opts.origin) headers['origin'] = opts.origin;
  const res = await fetch(`${stack.base}${pathname}`, {
    method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

/** Poll until `fn` returns truthy or the timeout elapses (returns last value). */
export async function waitFor<T>(
  fn: () => T | Promise<T>,
  timeoutMs = 5000,
  intervalMs = 50,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  for (;;) {
    last = await fn();
    if (last) return last;
    if (Date.now() > deadline) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
