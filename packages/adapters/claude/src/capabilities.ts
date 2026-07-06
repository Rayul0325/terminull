/**
 * Claude Code's honest capability matrix + the probe-time permission-mode
 * parser.
 *
 * Everything here is a DECLARATION the panel gates behaviour on. Two rules keep
 * it truthful:
 *  - The matrix starts from {@link minimalCapabilities} and raises only what
 *    Claude Code actually backs (pid-registry liveness, jsonl transcripts,
 *    stream-json headless, rich hooks, dynamic model discovery, resume/fork,
 *    whoami/usage/profiles accounts, editable harness files).
 *  - Permission modes are NOT hardcoded blindly. {@link parsePermissionModes}
 *    reads them out of `claude --help` at probe time; the hardcoded list is only
 *    a fallback, tagged `'builtin-maybe-stale'` so a consumer knows it may lag
 *    the installed CLI (the live CLI already diverges — it ships `auto`/`manual`
 *    which this fallback list predates).
 */
import { minimalCapabilities, type ToolCapabilities } from '@terminull/adapter-sdk';

/**
 * Fallback permission modes, used ONLY when `claude --help` cannot be parsed.
 * Tagged {@link PermissionModeSource} `'builtin-maybe-stale'` at the call site.
 * Deliberately NOT the source of truth — the installed CLI is.
 */
export const BUILTIN_PERMISSION_MODES: readonly string[] = [
  'default',
  'plan',
  'acceptEdits',
  'bypassPermissions',
  'dontAsk',
];

/** Where a permission-mode list came from — provenance for honesty. */
export type PermissionModeSource = 'parsed-help' | 'builtin-maybe-stale';

/** Result of resolving permission modes at probe time. */
export interface PermissionModeResult {
  modes: string[];
  source: PermissionModeSource;
}

/**
 * Extract the `--permission-mode` choices from `claude --help` output.
 *
 * The CLI renders them as `(choices: "acceptEdits", "auto", "bypassPermissions",
 * "manual", "dontAsk", "plan")` on (or wrapped after) the `--permission-mode`
 * option line. We locate that option, then take the FIRST `(choices: … )` group
 * at or after it. Returns the parsed list tagged `'parsed-help'`, or the builtin
 * fallback tagged `'builtin-maybe-stale'` when the shape is not found.
 */
export function parsePermissionModes(helpText: string | null | undefined): PermissionModeResult {
  if (typeof helpText === 'string' && helpText.length > 0) {
    const optIdx = helpText.indexOf('--permission-mode');
    if (optIdx >= 0) {
      // `help2` collapses the CLI's wrapped/indented continuation lines so a
      // `(choices: …)` split across lines is still matched.
      const region = helpText.slice(optIdx).replace(/\s+/g, ' ');
      const choices = /\(choices:\s*([^)]*)\)/.exec(region);
      if (choices && choices[1]) {
        const modes = [...choices[1].matchAll(/"([^"]+)"/g)]
          .map((m) => m[1])
          .filter((s): s is string => typeof s === 'string' && s.length > 0);
        if (modes.length > 0) return { modes, source: 'parsed-help' };
      }
    }
  }
  return { modes: [...BUILTIN_PERMISSION_MODES], source: 'builtin-maybe-stale' };
}

/**
 * The DECLARED Claude Code capability matrix (the `capabilities` field on the
 * adapter). `permissionModes` here is the builtin fallback; the probe replaces
 * it with the parsed-from-help list (and reports the parsed set back so the
 * conformance runner sees a consistent, non-empty value).
 *
 * `slashCommands` is `'discoverable'`: user commands under `~/.claude/commands`
 * are enumerable, though builtin commands are not — honest, since the mechanism
 * is real even if partial.
 */
export function claudeCapabilities(overrides?: Partial<ToolCapabilities>): ToolCapabilities {
  return minimalCapabilities({
    liveDetection: 'pid-registry',
    transcript: 'jsonl',
    headless: 'stream-json',
    acp: false,
    coDrive: 'none',
    hooks: 'rich',
    permissionModes: [...BUILTIN_PERMISSION_MODES],
    modelDiscovery: 'dynamic',
    slashCommands: 'discoverable',
    resume: true,
    fork: true,
    accounts: { whoami: true, usage: true, profiles: true, switch: false },
    harnessFiles: true,
    ...overrides,
  });
}
