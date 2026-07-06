/**
 * Antigravity (`agy`) honest capability matrix + the probe-time permission-mode
 * parser.
 *
 * Everything here is a DECLARATION the panel gates behaviour on. It is
 * deliberately "minimal-plus": agy is a chat-first TUI whose transcripts are
 * OPAQUE (SQLite files holding protobuf BLOBs — see `collector.ts`), so there is
 * NO transcript parser and no chat view. What agy DOES back honestly:
 *  - `liveDetection: 'mtime-heuristic'` — the only liveness signal is the
 *    conversation db mtime (no PID registry, no runtime file). Coarse by nature.
 *  - `transcript: 'opaque'` — a handle is exposed, but nothing parses it.
 *  - `headless: 'oneshot'` — `agy -p <text> [--conversation <id>] --print-timeout`.
 *  - `resume: true` — `--conversation <id>` resumes a previous conversation.
 *  - `modelDiscovery: 'configured'` — a `models` subcommand exists, but it may
 *    hit the network, so it is NEVER invoked here; models come from local config.
 *  - `accounts.whoami: true` — the active Google account is read from
 *    `google_accounts.json`. usage/profiles/switch are NOT backed.
 *  - `harnessFiles: true` — GEMINI.md + the antigravity settings.json.
 *
 * Permission modes are NOT hardcoded blindly. {@link parsePermissionModes} reads
 * them out of `agy --help` at probe time (the flags `--dangerously-skip-permissions`
 * and `--sandbox`); the hardcoded list is only a fallback, tagged
 * `'builtin-maybe-stale'` at the call site so a consumer knows it may lag the CLI.
 */
import { minimalCapabilities, type ToolCapabilities } from '@terminull/adapter-sdk';

/**
 * Fallback permission modes, used ONLY when `agy --help` cannot be parsed.
 * Tagged {@link PermissionModeSource} `'builtin-maybe-stale'` at the call site.
 * Deliberately NOT the source of truth — the installed CLI's `--help` is.
 *  - `default`               — normal, prompts for permission.
 *  - `skip-permissions`      — `--dangerously-skip-permissions` (auto-approve all).
 *  - `sandbox`               — `--sandbox` (terminal restrictions enabled).
 */
export const AGY_PERMISSION_MODES: readonly string[] = ['default', 'skip-permissions', 'sandbox'];

/** Where a permission-mode list came from — provenance for honesty. */
export type PermissionModeSource = 'parsed-help' | 'builtin-maybe-stale';

/** Result of resolving permission modes at probe time. */
export interface PermissionModeResult {
  modes: string[];
  source: PermissionModeSource;
}

/**
 * Derive the permission modes agy supports from `agy --help` output.
 *
 * agy has no `--permission-mode <choices>` option; instead it exposes two
 * mutually-independent flags. We map:
 *  - `--dangerously-skip-permissions` → `skip-permissions`
 *  - `--sandbox`                       → `sandbox`
 * `default` is always present (the no-flag behaviour). Returns the detected set
 * tagged `'parsed-help'`, or the builtin fallback tagged `'builtin-maybe-stale'`
 * when the help text is missing/empty.
 */
export function parsePermissionModes(helpText: string | null | undefined): PermissionModeResult {
  if (typeof helpText === 'string' && helpText.length > 0) {
    const modes = ['default'];
    if (/--dangerously-skip-permissions\b/.test(helpText)) modes.push('skip-permissions');
    if (/--sandbox\b/.test(helpText)) modes.push('sandbox');
    // Only trust the parse if it found at least one real flag beyond 'default'.
    if (modes.length > 1) return { modes, source: 'parsed-help' };
  }
  return { modes: [...AGY_PERMISSION_MODES], source: 'builtin-maybe-stale' };
}

/**
 * The DECLARED agy capability matrix (the `capabilities` field on the adapter).
 * Starts from {@link minimalCapabilities} and raises ONLY what agy actually
 * backs. `permissionModes` here is the builtin fallback; the probe replaces it
 * with the parsed-from-help set (and reports the parsed set back so the
 * conformance runner sees a consistent, non-empty value).
 */
export function agyCapabilities(overrides?: Partial<ToolCapabilities>): ToolCapabilities {
  return minimalCapabilities({
    liveDetection: 'mtime-heuristic',
    transcript: 'opaque',
    headless: 'oneshot',
    acp: false,
    coDrive: 'none',
    hooks: 'none',
    permissionModes: [...AGY_PERMISSION_MODES],
    modelDiscovery: 'configured',
    slashCommands: 'none',
    resume: true,
    fork: false,
    accounts: { whoami: true, usage: false, profiles: false, switch: false },
    harnessFiles: true,
    ...overrides,
  });
}
