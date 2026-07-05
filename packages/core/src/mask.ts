/**
 * Secret masking — TS port of the control-tower `ct_mask` sed suite.
 *
 * Best-effort redaction of obvious credentials in free text (house rule:
 * secrets never leave a process raw). Patterns are conservative and linear —
 * no nested quantifiers over overlapping classes, so there is no catastrophic
 * backtracking. Anything matched becomes the literal `[REDACTED]`.
 */

const REDACTED = '[REDACTED]';

/**
 * Self-identifying credential shapes — masked wherever they appear, no
 * surrounding marker word required.
 */
const STANDALONE_PATTERNS: readonly RegExp[] = [
  // OpenAI / Anthropic style: sk-...
  /sk-[A-Za-z0-9_-]{8,}/g,
  // GitHub tokens: ghp_ gho_ ghu_ ghs_ ghr_
  /gh[pousr]_[A-Za-z0-9]{16,}/g,
  // Slack tokens: xoxb- xoxa- xoxp- xoxr- xoxs-
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  // AWS access key ids: AKIA... / ASIA...
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  // JSON Web Tokens: eyJ....<base64url>.<base64url>
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/g,
  // npm tokens: npm_...
  /npm_[A-Za-z0-9]{16,}/g,
  // Underscore-prefixed provider keys: sk_ pk_ rk_ whsec_ api_ key_ token_ secret_
  /\b(?:sk|pk|rk|whsec|api|key|token|secret)_[A-Za-z0-9]{16,}/g,
];

/**
 * Marker-gated generic tokens: a long (32+ char) high-entropy value that
 * immediately follows a `token` / `secret` / `password` / `api[_-]?key` marker
 * and a short separator. Gating on the marker keeps benign long strings (URL
 * paths, hashes in prose) untouched. Group 1+2 (marker + separator) are kept.
 */
const MARKED_TOKEN =
  /\b(token|secret|password|api[_-]?key)([^A-Za-z0-9\n]{1,4})([A-Za-z0-9+/=_-]{32,})/gi;

/** Redact obvious secrets in `text`. Returns the input unchanged if empty. */
export function maskSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  for (const re of STANDALONE_PATTERNS) out = out.replace(re, REDACTED);
  out = out.replace(MARKED_TOKEN, `$1$2${REDACTED}`);
  return out;
}
