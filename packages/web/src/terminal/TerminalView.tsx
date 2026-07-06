/**
 * xterm terminal bound to the /pty bridge. Loaded LAZILY (TerminalPanel) so
 * xterm never enters the shell bundle. WebGL renderer is attempted and falls
 * back to the DOM renderer with an honest chip when unavailable.
 *
 * The wrapper carries data-terminull-scope="terminal": the keybinding manager
 * only fires mod+alt combos inside it — every other key belongs to the PTY.
 * A 4403 close on rw (no user credential) downgrades to a read-only retry
 * with an explicit notice, never a silent fake-interactive terminal.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { closeNotice, isReconnectableNotice, noticeAfterAttach } from './closeNotice';
import { connectPty, type PtyConnection } from './connectPty';

/**
 * Read a resolved `--tn-*` custom property off the document root. Falls back
 * to the literal (control-tower warm-dark palette, app.js:761-766) when run
 * outside a browser (SSR/tests never render this lazy-loaded component, but
 * the guard is cheap insurance) or before the stylesheet has painted.
 */
function tnVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/**
 * xterm palette derived from the LIVE `--tn-*` custom properties, so the
 * terminal always matches whichever theme family × mode is currently active
 * (Observatory or Clear, light or dark) — never a single hardcoded look.
 * Ported from the warm-dark control-tower TERM_THEME
 * (~/.claude/control-tower/public/js/app.js:761-766); those hex values now
 * live only as the `tnVar` fallback for each slot, since the real value is
 * re-read from the cascade every time the theme changes (see the
 * MutationObserver/matchMedia listener below).
 */
function buildXtermTheme(): ITheme {
  return {
    background: tnVar('--tn-bg', '#201c15'),
    foreground: tnVar('--tn-fg', '#ece4d3'),
    cursor: tnVar('--tn-accent', '#74b088'),
    cursorAccent: tnVar('--tn-bg', '#201c15'),
    selectionBackground: tnVar('--tn-border', '#3d3729'),
    black: tnVar('--tn-bg', '#201c15'),
    red: tnVar('--tn-err', '#d4796a'),
    green: tnVar('--tn-ok', '#74b088'),
    yellow: tnVar('--tn-run', '#cf9a3f'),
    blue: tnVar('--tn-ask', '#58a9ad'),
    magenta: tnVar('--tn-approve', '#a794c4'),
    cyan: tnVar('--tn-ask', '#58a9ad'),
    white: tnVar('--tn-fg', '#ece4d3'),
    brightBlack: tnVar('--tn-fg-faint', '#766c58'),
    brightRed: tnVar('--tn-err', '#d4796a'),
    brightGreen: tnVar('--tn-ok', '#74b088'),
    brightYellow: tnVar('--tn-run', '#cf9a3f'),
    brightBlue: tnVar('--tn-ask', '#58a9ad'),
    brightMagenta: tnVar('--tn-approve', '#a794c4'),
    brightCyan: tnVar('--tn-ask', '#58a9ad'),
    brightWhite: tnVar('--tn-fg', '#ece4d3'),
  };
}

const KEYBAR: Array<{ label: string; bytes: number[] }> = [
  { label: 'Esc', bytes: [0x1b] },
  { label: 'Tab', bytes: [0x09] },
  { label: '↑', bytes: [0x1b, 0x5b, 0x41] },
  { label: '↓', bytes: [0x1b, 0x5b, 0x42] },
  { label: '←', bytes: [0x1b, 0x5b, 0x44] },
  { label: '→', bytes: [0x1b, 0x5b, 0x43] },
  { label: '^C', bytes: [0x03] },
];

export default function TerminalView({
  sessionId,
  mode,
}: {
  sessionId: string;
  mode: 'rw' | 'ro';
}): ReactElement {
  const { t } = useTranslation();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const connRef = useRef<PtyConnection | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [effectiveMode, setEffectiveMode] = useState<'rw' | 'ro'>(mode);
  const [renderer, setRenderer] = useState<'webgl' | 'dom'>('webgl');
  // Bumped by the reconnect affordance after an abnormal close (1006 etc.) —
  // re-runs the connection effect with a fresh WS.
  const [attempt, setAttempt] = useState(0);

  // Keep the terminal's ANSI theme in sync with the live Observatory/Clear ×
  // light/dark selection. Runs independently of the connection effect below
  // (no PTY reconnect on a theme flip) — it just re-reads the `--tn-*`
  // cascade and hot-swaps `term.options.theme` whenever the root's
  // `data-theme`/`data-theme-family` attributes change (explicit pin) or the
  // OS-level dark-mode media query flips (auto mode).
  useEffect(() => {
    const applyTheme = (): void => {
      if (termRef.current) termRef.current.options.theme = buildXtermTheme();
    };
    const observer = new MutationObserver((mutations) => {
      if (
        mutations.some(
          (m) => m.attributeName === 'data-theme' || m.attributeName === 'data-theme-family',
        )
      ) {
        applyTheme();
      }
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-theme-family'],
    });
    const mq =
      typeof matchMedia !== 'undefined' ? matchMedia('(prefers-color-scheme: dark)') : null;
    mq?.addEventListener('change', applyTheme);
    return () => {
      observer.disconnect();
      mq?.removeEventListener('change', applyTheme);
    };
  }, []);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const term = new Terminal({
      fontFamily: 'var(--tn-font-mono)',
      fontSize: 13,
      convertEol: false,
      scrollback: 5000,
      disableStdin: effectiveMode === 'ro',
      theme: buildXtermTheme(),
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    try {
      term.loadAddon(new WebglAddon());
    } catch {
      setRenderer('dom');
    }
    fit.fit();

    const conn = connectPty(sessionId, effectiveMode, {
      // Reconnect label truth: a successful attach clears any stale closed_*
      // chip from the previous link (never a permanently stuck "끊김").
      onAttached: () => setNotice((n) => noticeAfterAttach(n)),
      onOutput: (data) => term.write(data),
      onErrorCode: (code) => setNotice(code),
      onClose: ({ code }) => {
        const outcome = closeNotice(code, effectiveMode);
        if (outcome.downgradeToRo) {
          // No user credential — honest downgrade to read-only.
          setNotice(outcome.notice);
          setEffectiveMode('ro');
          return;
        }
        if (outcome.notice !== null) setNotice(outcome.notice);
      },
    });
    connRef.current = conn;
    const encoder = new TextEncoder();
    const dataSub = term.onData((s) => {
      if (effectiveMode === 'rw') conn.sendInput(encoder.encode(s));
    });
    const resizeSub = term.onResize(({ cols, rows }) => {
      if (effectiveMode === 'rw') conn.resize(cols, rows);
    });
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(el);

    return () => {
      observer.disconnect();
      dataSub.dispose();
      resizeSub.dispose();
      conn.close();
      connRef.current = null;
      termRef.current = null;
      term.dispose();
    };
  }, [sessionId, effectiveMode, attempt]);

  return (
    <div
      data-terminull-scope="terminal"
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--tn-bg)',
      }}
    >
      {notice !== null || effectiveMode === 'ro' || renderer === 'dom' ? (
        <div
          style={{
            display: 'flex',
            gap: 6,
            padding: '2px 8px',
            fontSize: 12,
            background: 'var(--tn-bg-sunken)',
            color: 'var(--tn-fg-muted)',
          }}
        >
          {effectiveMode === 'ro' ? (
            <span className="tn-chip">{t('terminal.readOnly')}</span>
          ) : null}
          {notice !== null ? (
            <span className="tn-chip" style={{ color: 'var(--tn-warn)' }}>
              {t(`terminal.notice.${notice}`, notice)}
            </span>
          ) : null}
          {isReconnectableNotice(notice) ? (
            <button
              type="button"
              className="tn-btn"
              style={{ padding: '0 8px', fontSize: 12 }}
              onClick={() => setAttempt((n) => n + 1)}
            >
              {t('terminal.reconnect')}
            </button>
          ) : null}
          {renderer === 'dom' ? <span className="tn-chip">{t('terminal.domRenderer')}</span> : null}
        </div>
      ) : null}
      <div ref={hostRef} style={{ flex: 1, minHeight: 0 }} />
      <div
        style={{
          display: 'flex',
          gap: 4,
          padding: 4,
          borderTop: '1px solid var(--tn-border)',
          background: 'var(--tn-bg-sunken)',
          overflowX: 'auto',
        }}
      >
        {KEYBAR.map((k) => (
          <button
            key={k.label}
            type="button"
            className="tn-btn"
            style={{ padding: '2px 10px', fontSize: 12 }}
            disabled={effectiveMode === 'ro'}
            onClick={() => connRef.current?.sendInput(Uint8Array.from(k.bytes))}
          >
            {k.label}
          </button>
        ))}
      </div>
    </div>
  );
}
