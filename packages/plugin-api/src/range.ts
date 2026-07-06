/**
 * Plugin-API semver range gate — moved verbatim from
 * `@terminull/adapter-sdk`'s plugin-host in M10 so plugin AUTHORS can check
 * compatibility against the same code the runtime uses (the SDK re-exports
 * this function unchanged). A tiny built-in checker; no external semver
 * dependency, fail-closed on anything unparseable.
 */
import { PLUGIN_API_VERSION } from './manifest.js';

function compareComparator(token: string, version: number): boolean {
  const m = /^(>=|<=|>|<|=)?(\d+)/.exec(token);
  if (!m) return false;
  const op = m[1] ?? '=';
  const n = Number(m[2] ?? Number.NaN);
  switch (op) {
    case '>=':
      return version >= n;
    case '<=':
      return version <= n;
    case '>':
      return version > n;
    case '<':
      return version < n;
    default:
      return version === n;
  }
}

/**
 * Whether `range` admits the integer major `version`. Supported forms:
 *  - caret `^N` (and `^N.M.P`): major must equal `version`.
 *  - exact `N` (and `N.M.P`): major must equal `version`.
 *  - space-separated comparators `>=N <M`: every comparator must hold.
 * Anything unparseable is rejected (returns false) — fail closed.
 */
export function rangeSatisfies(range: string, version: number = PLUGIN_API_VERSION): boolean {
  const r = range.trim();
  if (r.length === 0) return false;

  const caret = /^\^(\d+)/.exec(r);
  if (caret) return Number(caret[1] ?? Number.NaN) === version;

  const exact = /^(\d+)(?:\.\d+)*$/.exec(r);
  if (exact) return Number(exact[1] ?? Number.NaN) === version;

  const parts = r.split(/\s+/).filter((p) => p.length > 0);
  if (parts.length > 0 && parts.every((p) => /^(>=|<=|>|<|=)?\d/.test(p))) {
    return parts.every((p) => compareComparator(p, version));
  }
  return false;
}
