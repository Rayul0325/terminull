/**
 * Local mirror of the server's machines.json helpers (packages/server/src/
 * machines.ts `loadMachinesFile`/`saveMachinesFile`). The CLI depends only on
 * @terminull/shared — adding a workspace dependency on @terminull/server would
 * require a lockfile change (forbidden for this track), so the two tiny
 * helpers are mirrored here byte-for-byte in behaviour: absent file = `[]`,
 * invalid file = throw (never silently dropped), save = write-then-rename
 * 0600. The SHAPE is still the single shared source of truth
 * ({@link MachinesFileSchema}). Recorded as an M8 deviation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { MACHINES_FILE, MachinesFileSchema, type MachineConfig } from '@terminull/shared';

/** Read `<stateDir>/machines.json`. Absent → []; invalid → throw. */
export function loadMachinesFile(stateDir: string): MachineConfig[] {
  const file = path.join(stateDir, MACHINES_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const parsed = MachinesFileSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(
      `invalid ${MACHINES_FILE}: ${parsed.error.issues[0]?.message ?? 'parse_error'}`,
    );
  }
  return parsed.data.machines;
}

/** Atomically write `<stateDir>/machines.json` (write-then-rename, 0600). */
export function saveMachinesFile(stateDir: string, machines: MachineConfig[]): void {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = path.join(stateDir, MACHINES_FILE);
  const body = JSON.stringify({ version: 1, machines }, null, 2) + '\n';
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
