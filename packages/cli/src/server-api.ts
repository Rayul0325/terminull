/**
 * Thin client for the local panel server: discovery-file lookup + the two
 * calls the CLI needs (`GET /api/machines`, `POST /api/machines/reload`).
 *
 * The discovery reader mirrors packages/server/src/discovery.ts
 * (`readDiscovery`) — same no-new-dependency reason as machines-file.ts;
 * recorded as an M8 deviation. A stale file after a crash is expected: the
 * pid is liveness-checked before the port is trusted.
 *
 * Honesty notes:
 *  - The CLI never reads the server token file (credentials are out of bounds
 *    for this track). `GET /api/machines` works over trusted loopback;
 *    `POST /api/machines/reload` is user-gated server-side, so the attempt may
 *    honestly come back 403 — the caller then prints the manual reload hint
 *    instead of pretending the reload happened.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { MachineStateDto } from '@terminull/shared';

/** Mirror of the server's discovery file shape (`<stateDir>/server.json`). */
export interface ServerDiscovery {
  port: number;
  pid: number;
}

const DISCOVERY_FILE = 'server.json';

/** Read `<stateDir>/server.json`; null when absent/corrupt. */
export function readDiscovery(stateDir: string): ServerDiscovery | null {
  try {
    const raw = fs.readFileSync(path.join(stateDir, DISCOVERY_FILE), 'utf8');
    const parsed = JSON.parse(raw) as ServerDiscovery;
    if (typeof parsed.port !== 'number' || typeof parsed.pid !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** True when the discovered pid is a live process (signal 0 probe). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Locate a LIVE server for the state dir, or null. */
export function liveServer(stateDir: string): ServerDiscovery | null {
  const disc = readDiscovery(stateDir);
  if (!disc || !pidAlive(disc.pid)) return null;
  return disc;
}

export type MachinesFetchResult =
  | { ok: true; machines: MachineStateDto[]; port: number }
  | { ok: false; reason: 'server_down' | 'no_machines_api' | 'bad_response'; detail?: string };

/** Fetch live machine states from the running server (loopback only). */
export async function fetchMachines(
  stateDir: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MachinesFetchResult> {
  const disc = liveServer(stateDir);
  if (!disc) return { ok: false, reason: 'server_down' };
  try {
    const res = await fetchImpl(`http://127.0.0.1:${disc.port}/api/machines`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) {
      return { ok: false, reason: 'no_machines_api', detail: `HTTP ${res.status}` };
    }
    const body = (await res.json()) as { machines?: MachineStateDto[] };
    if (!Array.isArray(body.machines)) {
      return { ok: false, reason: 'bad_response', detail: 'missing machines[]' };
    }
    return { ok: true, machines: body.machines, port: disc.port };
  } catch (err) {
    return { ok: false, reason: 'no_machines_api', detail: (err as Error).message };
  }
}

export type ReloadResult = { ok: true } | { ok: false; reason: string };

/**
 * Ask a running server to reload machines.json. Best-effort and honest: no
 * live server, a 403 (reload is user-gated and the CLI carries no credential)
 * or any network error is reported as not-reloaded — never claimed as done.
 */
export async function requestReload(
  stateDir: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ReloadResult> {
  const disc = liveServer(stateDir);
  if (!disc) return { ok: false, reason: 'server_down' };
  try {
    const res = await fetchImpl(`http://127.0.0.1:${disc.port}/api/machines/reload`, {
      method: 'POST',
      signal: AbortSignal.timeout(3_000),
    });
    if (res.ok) return { ok: true };
    return { ok: false, reason: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}
