/**
 * `/api/prefs/*` — server-persisted UI preferences (M9 D6: keybinding
 * overrides that roam across devices). Combos are OPAQUE here: the web
 * keybinding manager owns normalisation and the terminal-scope modifier rule;
 * the server only validates the DTO shape and persists it.
 *
 * PUT is full-replace and USER-ONLY (same bar as machines reload). The audit
 * event carries the touched action ids only — combos are prefs, not audit
 * material.
 */
import fs from 'node:fs';
import path from 'node:path';
import type http from 'node:http';
import type { EventStore } from '@terminull/core';
import { KEYBINDINGS_FILE, KeybindingsDtoSchema, type KeybindingsDto } from '@terminull/shared';
import type { Auth } from './auth.js';
import { Router, fail, json, readJsonBody } from './http-util.js';

/** What the prefs routes borrow from the server. */
export interface PrefsRouteDeps {
  auth: Auth;
  store: EventStore;
  stateDir: string;
}

const emptyKeybindings = (): KeybindingsDto => ({ version: 1, overrides: {} });

/**
 * Read the persisted keybindings. Absent file = empty overrides (a valid,
 * common state); an unreadable/invalid file is reported as null (the routes
 * turn that into a typed 500 — never silently reset user prefs).
 */
function loadKeybindings(stateDir: string): KeybindingsDto | 'absent' | 'invalid' {
  const file = path.join(stateDir, KEYBINDINGS_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return 'absent';
  }
  try {
    const parsed = KeybindingsDtoSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : 'invalid';
  } catch {
    return 'invalid';
  }
}

/** Atomically persist keybindings (write-then-rename, 0600). */
function saveKeybindings(stateDir: string, dto: KeybindingsDto): void {
  const file = path.join(stateDir, KEYBINDINGS_FILE);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(dto, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Action ids added, removed, or re-bound between two override maps. */
function touchedActionIds(prev: KeybindingsDto, next: KeybindingsDto): string[] {
  const ids = new Set<string>();
  for (const id of Object.keys(prev.overrides)) {
    if (!(id in next.overrides) || next.overrides[id] !== prev.overrides[id]) ids.add(id);
  }
  for (const id of Object.keys(next.overrides)) {
    if (!(id in prev.overrides)) ids.add(id);
  }
  return [...ids].sort();
}

/** Register every `/api/prefs/*` route on the server's router. */
export function registerPrefsRoutes(r: Router, deps: PrefsRouteDeps): void {
  r.add('GET', '/api/prefs/keybindings', (_req, res) => {
    const loaded = loadKeybindings(deps.stateDir);
    if (loaded === 'invalid') {
      fail(res, 500, 'keybindings_file_invalid');
      return;
    }
    json(res, 200, loaded === 'absent' ? emptyKeybindings() : loaded);
  });

  r.add('PUT', '/api/prefs/keybindings', async (req: http.IncomingMessage, res) => {
    // Only a POSITIVELY-credentialed user reshapes roaming prefs.
    if (deps.auth.actorOf(req) !== 'user') {
      fail(res, 403, 'user_required');
      return;
    }
    const body = KeybindingsDtoSchema.safeParse(await readJsonBody(req));
    if (!body.success) {
      fail(res, 400, 'bad_request');
      return;
    }
    const previous = loadKeybindings(deps.stateDir);
    // A corrupt previous file diffs against empty — the PUT itself repairs it.
    const prevDto = previous === 'absent' || previous === 'invalid'
      ? emptyKeybindings()
      : previous;
    saveKeybindings(deps.stateDir, body.data);
    deps.store.append('prefs.keybindings_changed', {
      actor: 'user',
      payload: { actionIds: touchedActionIds(prevDto, body.data) },
    });
    json(res, 200, body.data);
  });
}
