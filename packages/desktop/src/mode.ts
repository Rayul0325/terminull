/**
 * Attach/managed decision + managed-server orchestration helpers — PURE (no
 * electron). All I/O is behind injectable seams so the whole decision path is
 * unit-testable headlessly.
 *
 *  - ATTACH:  a live panel server already exists (server.json + live pid) →
 *             the shell just points a window at its loopback origin.
 *  - MANAGED: no live server → the shell spawns `terminull serve` as a child,
 *             polls server.json until it is live, loads it, and kills the child
 *             on quit.
 */
import { liveServer, pidAlive, readDiscovery, type ServerDiscovery } from './discovery.js';
import { isLoopbackUrl, panelOrigin } from './urls.js';

export type ShellMode = { kind: 'attach'; port: number; pid: number } | { kind: 'managed' };

export interface DecideDeps {
  /** Injectable live-server probe (defaults to discovery.liveServer). */
  live?: (stateDir: string) => ServerDiscovery | null;
}

/** attach when a live server is discovered, else managed. */
export function decideMode(stateDir: string, deps: DecideDeps = {}): ShellMode {
  const probe = deps.live ?? liveServer;
  const live = probe(stateDir);
  return live ? { kind: 'attach', port: live.port, pid: live.pid } : { kind: 'managed' };
}

export interface ServeCommand {
  cmd: string;
  args: string[];
}

/**
 * The command that starts a managed panel server. Default is `terminull serve`
 * (the published bin). Two documented test/dev seams:
 *  - `TERMINULL_SERVE_CMD` = a JSON string array `["cmd","arg",…]` (used by the
 *    smoke fake-bin fixture) — full override.
 *  - `TERMINULL_BIN` = swap only the executable name (keeps `serve`).
 */
export function resolveServeCommand(env: NodeJS.ProcessEnv = process.env): ServeCommand {
  const override = env['TERMINULL_SERVE_CMD'];
  if (override !== undefined && override !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(override);
    } catch {
      throw new Error('TERMINULL_SERVE_CMD must be a JSON array of strings');
    }
    if (!Array.isArray(parsed) || parsed.length === 0 || typeof parsed[0] !== 'string')
      throw new Error('TERMINULL_SERVE_CMD must be a non-empty JSON array of strings');
    return { cmd: parsed[0], args: parsed.slice(1).map(String) };
  }
  const bin = env['TERMINULL_BIN'];
  return { cmd: bin !== undefined && bin !== '' ? bin : 'terminull', args: ['serve'] };
}

/**
 * The URL the window loads for a resolved server port. `TERMINULL_PANEL_URL`
 * overrides it (dev: point at the vite server on http://localhost:5173) but is
 * honored ONLY when it is a loopback URL — a remote override is refused and we
 * fall back to the discovered loopback origin.
 */
export function resolvePanelUrl(port: number, env: NodeJS.ProcessEnv = process.env): string {
  const override = env['TERMINULL_PANEL_URL'];
  if (override !== undefined && override !== '' && isLoopbackUrl(override)) return override;
  return panelOrigin(port);
}

/** Raised when a managed server never became live within the timeout. */
export class ServerStartTimeout extends Error {
  constructor(
    readonly stateDir: string,
    readonly waitedMs: number,
  ) {
    super(`panel server did not become live within ${waitedMs}ms`);
    this.name = 'ServerStartTimeout';
  }
}

export interface PollDeps {
  read?: (stateDir: string) => ServerDiscovery | null;
  alive?: (pid: number) => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Poll `<stateDir>/server.json` until it names a LIVE pid, or throw
 * {@link ServerStartTimeout}. The pid liveness check is what makes a stale
 * server.json (crashed managed server) fail honestly instead of loading a dead
 * port.
 */
export async function pollForServer(
  stateDir: string,
  opts: { timeoutMs?: number; intervalMs?: number } & PollDeps = {},
): Promise<ServerDiscovery> {
  const read = opts.read ?? readDiscovery;
  const alive = opts.alive ?? pidAlive;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = opts.timeoutMs ?? 15000;
  const intervalMs = opts.intervalMs ?? 300;
  const start = now();
  for (;;) {
    const disc = read(stateDir);
    if (disc && alive(disc.pid)) return disc;
    const waited = now() - start;
    if (waited >= timeoutMs) throw new ServerStartTimeout(stateDir, waited);
    await sleep(intervalMs);
  }
}
