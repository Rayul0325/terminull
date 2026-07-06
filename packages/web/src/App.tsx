/**
 * App shell: top navigation + connection pill + route outlet, plus the
 * global keydown → KeybindingManager bridge (terminal-scope rule enforced in
 * the manager, not here).
 *
 * At the phone breakpoint the shell renders the bottom-tab MobileShell
 * INSTEAD of the routed outlet — the dockview tiling workspace is never
 * mounted on mobile (M9 W8 invariant, see lib/viewport.ts).
 */
import { useEffect, type ReactElement } from 'react';
import { Link, Outlet, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { keybindings } from './keybindings/manager';
import { useIsPhone } from './lib/viewport';
import { MobileShell } from './mobile/MobileShell';
import { useConnectionStore } from './stores/connection';
import { usePrefsStore } from './stores/prefs';

export function App(): ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const wsStatus = useConnectionStore((s) => s.wsStatus);
  const keybindOverrides = usePrefsStore((s) => s.keybindOverrides);
  const phone = useIsPhone();

  useEffect(() => {
    keybindings.setOverrides(keybindOverrides);
  }, [keybindOverrides]);

  useEffect(() => {
    const un1 = keybindings.register('nav.home', () => void navigate('/'));
    const un2 = keybindings.register('nav.settings', () => void navigate('/settings'));
    const onKeydown = (e: KeyboardEvent): void => {
      const fired = keybindings.dispatch(e);
      if (fired !== null) e.preventDefault();
    };
    window.addEventListener('keydown', onKeydown);
    return () => {
      un1();
      un2();
      window.removeEventListener('keydown', onKeydown);
    };
  }, [navigate]);

  const wsDot =
    wsStatus === 'online'
      ? 'tn-dot--live'
      : wsStatus === 'offline'
        ? 'tn-dot--down'
        : 'tn-dot--warn';

  if (phone) {
    // Phone breakpoint: bottom-tab shell, no tiled workspace (invariant).
    return <MobileShell />;
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '8px 14px',
          borderBottom: '1px solid var(--tn-border)',
          background: 'var(--tn-bg-elevated)',
        }}
      >
        <Link to="/" style={{ fontWeight: 700, color: 'var(--tn-fg)', textDecoration: 'none' }}>
          {t('app.name')}
        </Link>
        <span className="tn-chip">
          <span className={`tn-dot ${wsDot}`} />
          {t(`conn.ws.${wsStatus}`)}
        </span>
        <span style={{ flex: 1 }} />
        <Link to="/workspace/all" className="tn-btn">
          {t('nav.workspace')}
        </Link>
        <Link to="/settings" className="tn-btn">
          {t('nav.settings')}
        </Link>
      </header>
      <main style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        <Outlet />
      </main>
    </div>
  );
}
