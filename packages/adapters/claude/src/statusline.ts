/**
 * The Claude Code statusLine stdin schema (P1 prep).
 *
 * A `statusLine.command` receives, on stdin, a single JSON object describing the
 * live session: model, cost, context-window usage, PR/worktree state, rate
 * limits. It is the richest per-session telemetry Claude Code exposes with zero
 * transcript parsing (parity doc §5). This module ships the TYPE plus one
 * lenient parse helper so a future statusline shim (M6) can consume the payload
 * without re-deriving the shape. No shim PROCESS is wired here yet.
 *
 * Field optionality mirrors §5: a trailing `?` in the survey => optional here.
 * The helper is deliberately lenient — a partial/older CLI payload is common —
 * and returns `null` rather than throwing, honouring the adapter honesty rule
 * (never fabricate a field it cannot read).
 */

/** `model` block: the active model's stable id + human label. */
export interface StatusLineModel {
  id: string;
  display_name: string;
}

/** `workspace.repo` block: git host/owner/name, when the cwd is a repo. */
export interface StatusLineRepo {
  host?: string;
  owner?: string;
  name?: string;
}

/** `workspace` block: the current dir, project root, extra dirs, repo/worktree. */
export interface StatusLineWorkspace {
  current_dir: string;
  project_dir: string;
  added_dirs: string[];
  git_worktree?: string;
  repo?: StatusLineRepo;
}

/** `cost` block: cumulative spend + duration + edit line counts for the session. */
export interface StatusLineCost {
  total_cost_usd: number;
  total_duration_ms: number;
  total_api_duration_ms: number;
  total_lines_added: number;
  total_lines_removed: number;
}

/** `context_window.current_usage`: the most recent turn's token breakdown. */
export interface StatusLineCurrentUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

/** `context_window` block: totals, window size, and used/remaining percentages. */
export interface StatusLineContextWindow {
  total_input_tokens: number;
  total_output_tokens: number;
  context_window_size: number;
  used_percentage: number;
  remaining_percentage: number;
  current_usage: StatusLineCurrentUsage;
}

/** `rate_limits` block: the two rolling quota buckets, when reported. */
export interface StatusLineRateLimits {
  five_hour?: unknown;
  seven_day?: unknown;
}

/** `pr` block: the associated pull request, when the session tracks one. */
export interface StatusLinePr {
  number?: number;
  url?: string;
  review_state?: string;
}

/** `worktree` block: the git worktree backing this session, when present. */
export interface StatusLineWorktree {
  name?: string;
  path?: string;
  branch?: string;
}

/**
 * The full statusLine stdin payload (parity doc §5). Optional members are absent
 * on older CLIs or when the state does not apply (no PR, no worktree, no vim).
 */
export interface StatusLineInput {
  cwd: string;
  session_id: string;
  session_name?: string;
  prompt_id?: string;
  transcript_path: string;
  model: StatusLineModel;
  workspace: StatusLineWorkspace;
  version: string;
  output_style: { name: string };
  cost: StatusLineCost;
  context_window: StatusLineContextWindow;
  exceeds_200k_tokens: boolean;
  effort?: { level?: string };
  thinking: { enabled: boolean };
  rate_limits?: StatusLineRateLimits;
  vim?: { mode?: string };
  agent?: { name?: string };
  pr?: StatusLinePr;
  worktree?: StatusLineWorktree;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Parse a statusLine stdin payload (a JSON string or an already-parsed object)
 * into a typed {@link StatusLineInput}, or `null` when it is not a plausible
 * statusline payload.
 *
 * LENIENT by design: it validates only the load-bearing identity fields
 * (`session_id`, `transcript_path`, a `model.id`) — enough to be confident the
 * blob IS a statusline payload — then narrows the type. It never throws (a torn
 * or non-JSON input yields `null`) and never fabricates a missing field.
 */
export function parseStatusLine(input: string | unknown): StatusLineInput | null {
  let value: unknown = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch {
      return null;
    }
  }
  if (!isRecord(value)) return null;
  if (typeof value['session_id'] !== 'string') return null;
  if (typeof value['transcript_path'] !== 'string') return null;
  const model = value['model'];
  if (!isRecord(model) || typeof model['id'] !== 'string') return null;
  return value as unknown as StatusLineInput;
}
