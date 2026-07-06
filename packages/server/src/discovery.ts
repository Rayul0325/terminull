/**
 * Boot discovery file — `<stateDir>/server.json` (0600) tells local clients
 * (CLI, desktop app, hooks) where the running panel server listens without
 * scanning ports. Written on boot with the REAL bound port, removed on clean
 * shutdown; a stale file after a crash is expected and callers must verify the
 * pid/port before trusting it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PANEL_PROTO_VERSION } from '@terminull/shared';

/** Shape of `<stateDir>/server.json`. */
export interface ServerDiscovery {
  port: number;
  pid: number;
  protocol: typeof PANEL_PROTO_VERSION;
  coreVersion: string;
}

/** File name inside the state dir. */
export const DISCOVERY_FILE = 'server.json';

/** Write the discovery file (0600). Returns the file path. */
export function writeDiscovery(
  stateDir: string,
  info: { port: number; coreVersion: string; pid?: number },
): string {
  const file = path.join(stateDir, DISCOVERY_FILE);
  const body: ServerDiscovery = {
    port: info.port,
    pid: info.pid ?? process.pid,
    protocol: PANEL_PROTO_VERSION,
    coreVersion: info.coreVersion,
  };
  fs.mkdirSync(stateDir, { recursive: true });
  // Write-then-rename so a reader never sees a torn file; chmod via mode.
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}

/** Remove the discovery file (idempotent). */
export function removeDiscovery(stateDir: string): void {
  try {
    fs.unlinkSync(path.join(stateDir, DISCOVERY_FILE));
  } catch {
    /* never written or already removed */
  }
}

/** Read the discovery file, or null when absent/corrupt (caller verifies pid). */
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
