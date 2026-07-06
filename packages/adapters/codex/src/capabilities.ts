/**
 * Codex CLI's honest capability matrix + the probe-time permission-mode parser.
 *
 * Everything here is a DECLARATION the panel gates behaviour on. Honesty rules:
 *  - The matrix starts from {@link minimalCapabilities} and raises only what
 *    the Codex CLI actually backs (mtime-heuristic liveness, jsonl rollouts,
 *    exec-json headless, notify-only hooks, configured model discovery,
 *    resume/fork, usage/profiles accounts, editable harness files).
 *  - `coDrive` is declared `'none'` CONSERVATIVELY: the `codex app-server`
 *    channel is only surfaced when the probe confirms `codex app-server --help`
 *    exits 0 (verified on this machine). The probe UPGRADES coDrive to
 *    `'app-server'`; the static matrix never over-claims it.
 *  - Permission modes are NOT hardcoded blindly. {@link parsePermissionModes}
 *    reads the sandbox `[possible values: …]` list and the approval-policy
 *    tokens out of `codex --help` / `codex exec --help` at probe time; the
 *    hardcoded list is only a fallback, tagged `'builtin-maybe-stale'`.
 *  - `accounts.whoami` is FALSE: the adapter never parses `auth.json`, so it can
 *    report login PRESENCE but no identity string (see usage.ts).
 */
import { minimalCapabilities, type ToolCapabilities } from '@terminull/adapter-sdk';

/**
 * Fallback permission modes, used ONLY when `codex --help` cannot be parsed.
 * The union of the sandbox policies and the approval policies the CLI accepts
 * (codex-cli 0.142.5). Tagged {@link PermissionModeSource} `'builtin-maybe-stale'`
 * at the call site — deliberately NOT the source of truth (the installed CLI is).
 */
export const BUILTIN_PERMISSION_MODES: readonly string[] = [
  'read-only',
  'workspace-write',
  'danger-full-access',
  'untrusted',
  'on-failure',
  'on-request',
  'never',
];

/** Where a permission-mode list came from — provenance for honesty. */
export type PermissionModeSource = 'parsed-help' | 'builtin-maybe-stale';

/** Result of resolving permission modes at probe time. */
export interface PermissionModeResult {
  modes: string[];
  source: PermissionModeSource;
}

/** Approval-policy tokens the CLI documents as `-a/--ask-for-approval` values. */
const KNOWN_APPROVAL = ['untrusted', 'on-failure', 'on-request', 'never'] as const;

/**
 * Extract the sandbox + approval permission modes from `codex --help` /
 * `codex exec --help` output.
 *
 * The CLI renders sandbox modes as `[possible values: read-only, workspace-write,
 * danger-full-access]` and approval policies as a bulleted list (`- on-request:
 * …`). We lift the sandbox list from the `[possible values: … ]` group and scan
 * for the documented approval tokens, returning the union tagged `'parsed-help'`,
 * or the builtin fallback tagged `'builtin-maybe-stale'` when neither shape is found.
 */
export function parsePermissionModes(helpText: string | null | undefined): PermissionModeResult {
  if (typeof helpText === 'string' && helpText.length > 0) {
    const modes: string[] = [];

    // Sandbox modes: the first `[possible values: … ]` group in the text.
    const pv = /\[possible values:\s*([^\]]*)\]/.exec(helpText);
    if (pv && pv[1]) {
      for (const raw of pv[1].split(',')) {
        const tok = raw.trim();
        if (tok.length > 0 && !modes.includes(tok)) modes.push(tok);
      }
    }

    // Approval policies: the documented tokens, wherever they appear as list
    // items or inline (bounded to the known set so free text can't leak in).
    for (const tok of KNOWN_APPROVAL) {
      const re = new RegExp(`(^|[\\s\\-])${tok}(?=[\\s:,)]|$)`, 'm');
      if (re.test(helpText) && !modes.includes(tok)) modes.push(tok);
    }

    if (modes.length > 0) return { modes, source: 'parsed-help' };
  }
  return { modes: [...BUILTIN_PERMISSION_MODES], source: 'builtin-maybe-stale' };
}

/**
 * The DECLARED Codex CLI capability matrix (the `capabilities` field on the
 * adapter). `permissionModes` here is the builtin fallback; the probe replaces
 * it with the parsed-from-help list. `coDrive` defaults to `'none'` and is only
 * raised to `'app-server'` by the probe (or an explicit override) once the
 * `codex app-server` subcommand is confirmed present.
 *
 * `slashCommands` is `'none'`: Codex has no user-enumerable slash-command dir the
 * adapter can honestly discover.
 */
export function codexCapabilities(overrides?: Partial<ToolCapabilities>): ToolCapabilities {
  return minimalCapabilities({
    liveDetection: 'mtime-heuristic',
    transcript: 'jsonl',
    headless: 'exec-json',
    acp: false,
    coDrive: 'none',
    hooks: 'notify-only',
    permissionModes: [...BUILTIN_PERMISSION_MODES],
    modelDiscovery: 'configured',
    slashCommands: 'none',
    resume: true,
    fork: true,
    accounts: { whoami: false, usage: true, profiles: true, switch: false },
    harnessFiles: true,
    ...overrides,
  });
}
