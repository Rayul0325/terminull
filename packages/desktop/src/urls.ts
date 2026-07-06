/**
 * URL / loopback predicates — PURE (no electron, no node:fs). These encode the
 * shell's single security invariant: the window may ever touch ONLY loopback
 * content. Every navigation guard, popout allow-list and network-resource block
 * routes through here so "no remote content" is one auditable rule, not a
 * scatter of string checks.
 */

/** Loopback hostnames the shell trusts (IPv4 loopback, `localhost`, IPv6 ::1). */
export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

/** Parse a URL without throwing; null on anything malformed. */
export function parseUrlSafe(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/**
 * True iff `raw` is an http(s)/ws(s) URL pointed at a loopback host. Used by the
 * popout allow-list and the network-resource block. Non-network schemes
 * (`data:`, `blob:`, `about:`, `devtools:`) are NOT loopback URLs — the callers
 * decide those separately (they are not "remote content").
 */
export function isLoopbackUrl(raw: string): boolean {
  const u = parseUrlSafe(raw);
  if (!u) return false;
  if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'ws:' && u.protocol !== 'wss:')
    return false;
  return isLoopbackHostname(u.hostname);
}

/** The panel origin the shell loads for a discovered/managed server port. */
export function panelOrigin(port: number): string {
  return `http://127.0.0.1:${port}`;
}
