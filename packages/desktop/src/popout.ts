/**
 * Popout + navigation policy — PURE (unit-tested without electron).
 *
 * The web panel uses dockview, whose "popout group" opens a child window via
 * `window.open('/popout.html', …)` (packages/web/src/workspace/DockWorkspace.tsx
 * :183). Resolved against the loaded loopback origin that becomes
 * `http://127.0.0.1:<port>/popout.html` — same host as the app. The shell must
 * allow EXACTLY that (same loopback host) and deny everything else, so a
 * compromised/renamed link can never spawn a window onto remote content.
 */
import { isLoopbackUrl, parseUrlSafe } from './urls.js';

/**
 * Allow a popout window ONLY when the target is a loopback URL on the SAME host
 * (incl. port) the app was loaded from. `appHost` is `URL(loadedUrl).host`
 * (e.g. `127.0.0.1:7420`). Anything non-loopback or cross-host is denied.
 */
export function isAllowedPopout(rawUrl: string, appHost: string | null): boolean {
  if (!appHost) return false;
  if (!isLoopbackUrl(rawUrl)) return false;
  const u = parseUrlSafe(rawUrl);
  return u !== null && u.host === appHost;
}

/**
 * Guard for in-page navigations (`will-navigate`). The app should only ever
 * navigate within its loopback origin; our own honest-error screens are served
 * as `data:` / `about:blank`. Everything else (a link to a remote site) is
 * refused — the shell never loads remote content.
 */
export function isNavigationAllowed(rawUrl: string, appHost: string | null): boolean {
  if (rawUrl === 'about:blank') return true;
  if (rawUrl.startsWith('data:')) return true;
  if (!isLoopbackUrl(rawUrl)) return false;
  const u = parseUrlSafe(rawUrl);
  if (!u) return false;
  // Once an app host is known, pin navigations to it; before first load
  // (appHost null) any loopback origin is acceptable.
  return appHost === null || u.host === appHost;
}

/**
 * Network-resource block for `webRequest.onBeforeRequest`. Returns true when a
 * request MUST be cancelled: any http(s)/ws(s) request to a NON-loopback host.
 * data:/blob:/about:/devtools:/file: and all loopback traffic pass (false).
 * This is the load-bearing "no remote content" enforcement — it holds even if a
 * served page tried to fetch an external asset.
 */
export function isBlockedResource(rawUrl: string): boolean {
  const u = parseUrlSafe(rawUrl);
  if (!u) return false; // let electron reject unparseable itself
  if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'ws:' && u.protocol !== 'wss:')
    return false; // data:/blob:/about:/devtools:/file: are local, not remote
  return !isLoopbackUrl(rawUrl);
}
