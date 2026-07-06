/**
 * Local mirror of the panel server's discovery-file reader
 * (`packages/server/src/discovery.ts` + the CLI's `server-api.ts` mirror).
 * Duplicated on purpose: the desktop shell stays DEPENDENCY-FREE (thin
 * client, zero native modules, no workspace imports) — same recorded
 * deviation as the M8 CLI mirror. A stale file after a crash is expected;
 * the pid is liveness-checked before the port is trusted.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Shape of `<stateDir>/server.json` (fields the shell needs). */
export interface ServerDiscovery {
  port: number;
  pid: number;
}

const DISCOVERY_FILE = 'server.json';

/** Default state dir; override with TERMINULL_STATE_DIR (tests: fake homes). */
export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.TERMINULL_STATE_DIR ?? path.join(os.homedir(), '.terminull');
}

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

/** Locate a LIVE server for the state dir, or null (→ managed mode). */
export function liveServer(stateDir: string): ServerDiscovery | null {
  const disc = readDiscovery(stateDir);
  if (!disc || !pidAlive(disc.pid)) return null;
  return disc;
}
