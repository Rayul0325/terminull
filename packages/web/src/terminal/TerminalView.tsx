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
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { closeNotice, isReconnectableNotice, noticeAfterAttach } from './closeNotice';
import { connectPty, type PtyConnection } from './connectPty';

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
  const [notice, setNotice] = useState<string | null>(null);
  const [effectiveMode, setEffectiveMode] = useState<'rw' | 'ro'>(mode);
  const [renderer, setRenderer] = useState<'webgl' | 'dom'>('webgl');
  // Bumped by the reconnect affordance after an abnormal close (1006 etc.) —
  // re-runs the connection effect with a fresh WS.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const term = new Terminal({
      fontFamily: 'var(--tn-font-mono)',
      fontSize: 13,
      convertEol: false,
      scrollback: 5000,
      disableStdin: effectiveMode === 'ro',
    });
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
      term.dispose();
    };
  }, [sessionId, effectiveMode, attempt]);

  return (
    <div
      data-terminull-scope="terminal"
      style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#000' }}
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
