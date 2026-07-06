/**
 * The dockview workspace shell: panel registry binding, layout templates
 * (built-ins + saved + per-project default + last-layout restore), popout to
 * child windows, and the workspace keybinding actions.
 *
 * Layout restore order: per-project default template → last-used layout →
 * the 'chat' built-in. A saved layout that fails to materialize (stale panel
 * ids, plugin gone) is DISCARDED with a visible notice — never a white screen.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { DockviewReact, type DockviewApi, type DockviewReadyEvent } from 'dockview';
import 'dockview/dist/styles/dockview.css';
import { useFleetStore } from '../stores/fleet';
import {
  BUILTIN_TEMPLATE_IDS,
  clearLastLayout,
  loadLastLayout,
  saveLastLayout,
  useLayoutStore,
} from '../stores/layout';
import { usePrefsStore } from '../stores/prefs';
import { keybindings } from '../keybindings/manager';
import type { FleetSession } from '../api/types';
import { BUILTIN_LAYOUTS } from './builtinLayouts';
import { dockviewComponents } from './panelRegistry';
import { registerBuiltinPanels } from './registerBuiltins';
import { WorkspaceContext, type WorkspaceActions } from './WorkspaceContext';

registerBuiltinPanels();

function useResolvedTheme(): 'light' | 'dark' {
  const theme = usePrefsStore((s) => s.theme);
  const [system, setSystem] = useState<'light' | 'dark'>(() =>
    typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light',
  );
  useEffect(() => {
    if (typeof matchMedia === 'undefined') return;
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const onChange = (): void => setSystem(mq.matches ? 'dark' : 'light');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return theme === 'auto' ? system : theme;
}

export function DockWorkspace({
  projectId,
  sessions,
  focusSessionId,
}: {
  projectId: string;
  sessions: FleetSession[];
  focusSessionId?: string;
}): ReactElement {
  const { t } = useTranslation();
  const apiRef = useRef<DockviewApi | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [restoreNotice, setRestoreNotice] = useState<string | null>(null);
  const [saveName, setSaveName] = useState('');
  const resolvedTheme = useResolvedTheme();
  const layoutStore = useLayoutStore();
  const fleetById = useFleetStore((s) => s.sessionById);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  const applyTemplate = useCallback(
    (templateId: string): void => {
      const api = apiRef.current;
      if (!api) return;
      const builtin = BUILTIN_LAYOUTS[templateId];
      try {
        if (builtin) {
          api.clear();
          builtin.build(api, { projectId, sessions: sessionsRef.current });
          setRestoreNotice(null);
          return;
        }
        const saved = useLayoutStore.getState().templates[templateId];
        if (saved) {
          api.fromJSON(saved.layout as Parameters<DockviewApi['fromJSON']>[0]);
          setRestoreNotice(null);
        }
      } catch {
        // A template that cannot materialize falls back to the chat built-in,
        // with a visible notice (honesty: no silent recovery).
        api.clear();
        BUILTIN_LAYOUTS['chat']!.build(api, { projectId, sessions: sessionsRef.current });
        setRestoreNotice('template_failed');
      }
    },
    [projectId],
  );

  const onReady = useCallback(
    (event: DockviewReadyEvent): void => {
      const api = event.api;
      apiRef.current = api;
      void (async () => {
        await useLayoutStore.getState().load();
        const defaultTemplate = useLayoutStore.getState().defaultFor(projectId);
        if (defaultTemplate !== undefined) {
          applyTemplate(defaultTemplate);
        } else {
          const last = await loadLastLayout(projectId);
          if (last !== undefined) {
            try {
              api.fromJSON(last as Parameters<DockviewApi['fromJSON']>[0]);
            } catch {
              await clearLastLayout(projectId);
              applyTemplate('chat');
              setRestoreNotice('last_layout_failed');
            }
          } else {
            applyTemplate('chat');
          }
        }
        if (focusSessionId) {
          const session = fleetById(focusSessionId);
          openSession(focusSessionId, session?.tool ?? 'generic-pty');
        }
      })();
      // Persist the layout (debounced) so re-entry restores the last state.
      api.onDidLayoutChange(() => {
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
          try {
            void saveLastLayout(projectId, api.toJSON());
          } catch {
            /* serialization failed — skip this save, next change retries */
          }
        }, 800);
      });
    },
    // openSession closes over refs/zustand lookups only — stable per mount.
    [projectId, focusSessionId, applyTemplate],
  );

  function openSession(sessionId: string, adapterId: string): void {
    const api = apiRef.current;
    if (!api) return;
    const id = `session:${sessionId}`;
    const existing = api.getPanel(id);
    if (existing) {
      existing.api.setActive();
      return;
    }
    const session = fleetById(sessionId);
    api.addPanel({
      id,
      component: 'session',
      title: session?.title ?? sessionId,
      params: { sessionId, adapterId },
    });
  }

  function openTerminal(sessionId: string, mode: 'rw' | 'ro'): void {
    const api = apiRef.current;
    if (!api) return;
    // Mode-scoped panel id: an rw request must never silently focus an
    // existing read-only terminal (M9 W6). The ro id keeps the legacy shape
    // so saved layouts stay valid.
    const id = mode === 'rw' ? `terminal:${sessionId}:rw` : `terminal:${sessionId}`;
    const existing = api.getPanel(id);
    if (existing) {
      existing.api.setActive();
      return;
    }
    api.addPanel({
      id,
      component: 'terminal',
      title: mode === 'rw' ? t('terminal.attachRw') : t('panel.kind.terminal'),
      params: { sessionId, mode },
    });
  }

  function popoutActive(): void {
    const api = apiRef.current;
    const target = api?.activeGroup ?? api?.activePanel?.group;
    if (!api || !target) return;
    void api.addPopoutGroup(target, { popoutUrl: '/popout.html' });
  }

  const actions = useMemo<WorkspaceActions>(
    () => ({
      openSessionPanel: openSession,
      openTerminalPanel: openTerminal,
      popoutActive,
    }),
    // These close over apiRef/fleet lookups only — stable for the mount.
    [],
  );

  useEffect(() => {
    const un1 = keybindings.register('workspace.nextTab', () =>
      apiRef.current?.moveToNext({ includePanel: true }),
    );
    const un2 = keybindings.register('workspace.prevTab', () =>
      apiRef.current?.moveToPrevious({ includePanel: true }),
    );
    const un3 = keybindings.register('workspace.nextGroup', () => apiRef.current?.moveToNext());
    return () => {
      un1();
      un2();
      un3();
    };
  }, []);

  const savedNames = Object.keys(layoutStore.templates);
  const currentDefault = layoutStore.defaults[projectId] ?? '';

  return (
    <WorkspaceContext.Provider value={actions}>
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
        <div
          style={{
            display: 'flex',
            gap: 6,
            alignItems: 'center',
            padding: '4px 8px',
            borderBottom: '1px solid var(--tn-border)',
            flexWrap: 'wrap',
          }}
        >
          <label style={{ fontSize: 12, color: 'var(--tn-fg-muted)' }}>
            {t('layout.template')}
            <select
              className="tn-input"
              style={{ width: 'auto', marginLeft: 6, padding: '2px 6px' }}
              value=""
              onChange={(e) => {
                if (e.target.value) applyTemplate(e.target.value);
              }}
            >
              <option value="">{t('layout.apply')}</option>
              {BUILTIN_TEMPLATE_IDS.map((tid) => (
                <option key={tid} value={tid}>
                  {t(BUILTIN_LAYOUTS[tid]!.labelKey)}
                </option>
              ))}
              {savedNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <input
            className="tn-input"
            style={{ width: 160, padding: '2px 6px' }}
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            placeholder={t('layout.saveNamePlaceholder')}
            aria-label={t('layout.saveNamePlaceholder')}
          />
          <button
            type="button"
            className="tn-btn"
            disabled={saveName.trim() === ''}
            onClick={() => {
              const api = apiRef.current;
              if (!api) return;
              void useLayoutStore.getState().saveTemplate(saveName.trim(), api.toJSON());
              setSaveName('');
            }}
          >
            {t('layout.saveAs')}
          </button>
          <label style={{ fontSize: 12, color: 'var(--tn-fg-muted)' }}>
            {t('layout.defaultFor')}
            <select
              className="tn-input"
              style={{ width: 'auto', marginLeft: 6, padding: '2px 6px' }}
              value={currentDefault}
              onChange={(e) =>
                void useLayoutStore
                  .getState()
                  .setDefault(projectId, e.target.value === '' ? null : e.target.value)
              }
            >
              <option value="">{t('layout.noDefault')}</option>
              {BUILTIN_TEMPLATE_IDS.map((tid) => (
                <option key={tid} value={tid}>
                  {t(BUILTIN_LAYOUTS[tid]!.labelKey)}
                </option>
              ))}
              {savedNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <span style={{ flex: 1 }} />
          {restoreNotice !== null ? (
            <span className="tn-chip" style={{ color: 'var(--tn-warn)' }}>
              {t(`layout.notice.${restoreNotice}`)}
            </span>
          ) : null}
          <button type="button" className="tn-btn" onClick={popoutActive}>
            {t('layout.popout')}
          </button>
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          <DockviewReact
            className={resolvedTheme === 'dark' ? 'dockview-theme-dark' : 'dockview-theme-light'}
            components={dockviewComponents()}
            onReady={onReady}
          />
        </div>
      </div>
    </WorkspaceContext.Provider>
  );
}
