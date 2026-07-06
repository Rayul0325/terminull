/**
 * Honest in-shell status screens — PURE. When there is no panel to show (no live
 * server and no managed server could be started) the shell renders a plain,
 * self-contained `data:` page in Korean that says exactly what happened and how
 * to fix it — never a blank window, never a fake "loading" state.
 *
 * These are `data:` documents (no remote content, no scripts).
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Build a minimal self-contained screen document (no external assets). */
export function screenHtml(title: string, detail: string): string {
  return (
    '<!doctype html><html lang="ko"><head><meta charset="utf-8">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">' +
    '<title>Terminull</title><style>' +
    'html,body{height:100%}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;' +
    'background:#0e0f13;color:#e7e7ee;display:grid;place-items:center}' +
    '.card{max-width:34rem;padding:2.5rem;text-align:center}' +
    'h1{font-size:1.15rem;margin:0 0 .75rem;font-weight:650}' +
    'p{margin:0;opacity:.72;line-height:1.65;font-size:.9rem;white-space:pre-wrap}' +
    '</style></head><body><div class="card"><h1>' +
    escapeHtml(title) +
    '</h1><p>' +
    escapeHtml(detail) +
    '</p></div></body></html>'
  );
}

/** Wrap a screen document as a loadable `data:` URL. */
export function dataUrl(html: string): string {
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

/** The two honest failure states the shell can hit. */
export const SCREENS = {
  managedFailed: (detail: string): string => screenHtml('패널 서버를 시작하지 못했습니다', detail),
  managedUnavailable: (detail: string): string =>
    screenHtml('실행 중인 패널 서버가 없습니다', detail),
} as const;
