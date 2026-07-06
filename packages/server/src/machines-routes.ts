/**
 * `/api/machines*` — the machine registry surface (M8).
 *
 * GET lists every machine's live connection state (the implicit `'local'`
 * mirror entry first — one uniform rail for clients). Reload re-reads
 * `<stateDir>/machines.json` and applies the diff; it is USER-ONLY, exactly
 * like confirmation resolution: agents must not add ssh targets to the fleet.
 *
 * Registered in its own module (mirroring agent-routes) — app.ts is already
 * >1100 lines and machine wiring must not grow it further (contract §0).
 */
import type http from 'node:http';
import type { MachineStateDto } from '@terminull/shared';
import type { Auth } from './auth.js';
import { Router, fail, json } from './http-util.js';
import { loadMachinesFile, type MachineManager } from './machines.js';

/** What the machine routes borrow from the server. */
export interface MachinesRouteDeps {
  auth: Auth;
  stateDir: string;
  manager: MachineManager;
  /** The implicit local machine's mirror DTO (server-owned honesty). */
  localDto(): MachineStateDto;
  /** Post-reload hook (the server drops its fleet cache). */
  onReloaded?(): void;
}

function machineList(deps: MachinesRouteDeps): { machines: MachineStateDto[] } {
  return { machines: [deps.localDto(), ...deps.manager.states()] };
}

/** Register every `/api/machines*` route on the server's router. */
export function registerMachinesRoutes(r: Router, deps: MachinesRouteDeps): void {
  r.add('GET', '/api/machines', (_req, res) => {
    json(res, 200, machineList(deps));
  });

  r.add('POST', '/api/machines/reload', (req: http.IncomingMessage, res) => {
    // Only a POSITIVELY-credentialed user reshapes the machine fleet — same
    // bar as resolving confirmations.
    if (deps.auth.actorOf(req) !== 'user') {
      fail(res, 403, 'user_required');
      return;
    }
    let machines;
    try {
      machines = loadMachinesFile(deps.stateDir);
    } catch {
      fail(res, 400, 'machines_file_invalid');
      return;
    }
    try {
      deps.manager.reload(machines);
    } catch {
      // reload() validates the set atomically (reserved/duplicate ids) before
      // touching any runtime, so a refusal here left the fleet untouched.
      fail(res, 400, 'machines_file_invalid');
      return;
    }
    deps.onReloaded?.();
    json(res, 200, machineList(deps));
  });
}
