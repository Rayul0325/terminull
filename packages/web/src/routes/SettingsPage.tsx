/**
 * /settings — locale, theme, keybinding customization (GUI editor v1:
 * click-to-rebind with conflict warning + reset), layout template management,
 * and the honest device-sync status (layout sync is device-local until the
 * server endpoint lands — the UI says exactly that).
 */
import { useEffect, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { AccountCenterSection } from '../account/AccountCenterSection';
import { AgentPermissionsSection } from '../agent/AgentPermissionsSection';
import { HarnessSection } from '../harness/HarnessSection';
import { MachinesSection } from '../machines/MachinesSection';
import { KEY_ACTIONS } from '../keybindings/defaults';
import { comboAllowedInTerminal, keybindings, normalizeCombo } from '../keybindings/manager';
import { layoutSync, useLayoutStore } from '../stores/layout';
import { usePrefsStore, type ThemeFamily, type ThemeMode } from '../stores/prefs';

function KeybindRow({
  actionId,
  labelKey,
  capturing,
  onCapture,
}: {
  actionId: string;
  labelKey: string;
  capturing: boolean;
  onCapture: (actionId: string | null) => void;
}): ReactElement {
  const { t } = useTranslation();
  const overrides = usePrefsStore((s) => s.keybindOverrides);
  const combo = keybindings.comboFor(actionId);
  const overridden = actionId in overrides;
  return (
    <tr>
      <td style={{ padding: '6px 8px' }}>{t(labelKey)}</td>
      <td style={{ padding: '6px 8px' }}>
        <code style={{ fontFamily: 'var(--tn-font-mono)' }}>
          {combo ?? t('settings.keys.unbound')}
        </code>
        {combo !== null && !comboAllowedInTerminal(combo) ? (
          <span className="tn-chip" style={{ marginLeft: 6, color: 'var(--tn-warn)' }}>
            {t('settings.keys.notInTerminal')}
          </span>
        ) : null}
      </td>
      <td style={{ padding: '6px 8px', display: 'flex', gap: 6 }}>
        <button
          type="button"
          className="tn-btn"
          onClick={() => onCapture(capturing ? null : actionId)}
        >
          {capturing ? t('settings.keys.pressNow') : t('settings.keys.rebind')}
        </button>
        {overridden ? (
          <button
            type="button"
            className="tn-btn"
            onClick={() => {
              const next = { ...usePrefsStore.getState().keybindOverrides };
              delete next[actionId];
              usePrefsStore.setState({ keybindOverrides: next });
            }}
          >
            {t('settings.keys.resetOne')}
          </button>
        ) : null}
      </td>
    </tr>
  );
}

export function SettingsPage(): ReactElement {
  const { t } = useTranslation();
  const prefs = usePrefsStore();
  const layout = useLayoutStore();
  const [capturing, setCapturing] = useState<string | null>(null);

  const loadLayouts = layout.load;
  useEffect(() => {
    void loadLayouts();
  }, [loadLayouts]);

  useEffect(() => {
    keybindings.setOverrides(prefs.keybindOverrides);
  }, [prefs.keybindOverrides]);

  useEffect(() => {
    if (capturing === null) return;
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      const combo = normalizeCombo(e);
      if (combo === null) return; // bare modifier — keep capturing
      if (e.key === 'Escape') {
        setCapturing(null);
        return;
      }
      prefs.setKeybindOverride(capturing, combo);
      setCapturing(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [capturing, prefs]);

  const conflicts = keybindings.detectConflicts();

  return (
    <div style={{ maxWidth: 760, margin: '0 auto', padding: 16, display: 'grid', gap: 12 }}>
      <section className="tn-card" style={{ padding: 16 }}>
        <h2 style={{ margin: '0 0 8px', fontSize: 16 }}>{t('settings.general.title')}</h2>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>
            {t('settings.general.locale')}
            <select
              className="tn-input"
              value={prefs.locale}
              onChange={(e) => prefs.setLocale(e.target.value)}
            >
              <option value="ko">{t('settings.general.localeKo')}</option>
              <option value="en">{t('settings.general.localeEn')}</option>
            </select>
          </label>
          <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>
            {t('settings.general.theme')}
            <select
              className="tn-input"
              value={prefs.theme}
              onChange={(e) => prefs.setTheme(e.target.value as ThemeMode)}
            >
              <option value="auto">{t('settings.general.themeAuto')}</option>
              <option value="light">{t('settings.general.themeLight')}</option>
              <option value="dark">{t('settings.general.themeDark')}</option>
            </select>
          </label>
          <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>
            {t('settings.general.themeFamily')}
            <select
              className="tn-input"
              value={prefs.themeFamily}
              onChange={(e) => prefs.setThemeFamily(e.target.value as ThemeFamily)}
            >
              <option value="observatory">{t('settings.general.familyObservatory')}</option>
              <option value="clear">{t('settings.general.familyClear')}</option>
            </select>
          </label>
        </div>
      </section>

      <section className="tn-card" style={{ padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <h2 style={{ margin: 0, fontSize: 16, flex: 1 }}>{t('settings.keys.title')}</h2>
          <button type="button" className="tn-btn" onClick={() => prefs.resetKeybinds()}>
            {t('settings.keys.resetAll')}
          </button>
        </div>
        <p style={{ fontSize: 12, color: 'var(--tn-fg-muted)' }}>{t('settings.keys.scopeRule')}</p>
        <p style={{ fontSize: 12, color: 'var(--tn-fg-faint)' }}>
          {prefs.keybindsSync === 'synced'
            ? t('settings.keys.roamingSynced')
            : prefs.keybindsSync === 'syncing'
              ? t('settings.keys.roamingSyncing')
              : prefs.keybindsSync === 'error'
                ? t('settings.keys.roamingLocal', { code: prefs.keybindsSyncCode ?? '' })
                : null}
        </p>
        {conflicts.length > 0 ? (
          <div style={{ color: 'var(--tn-danger)', fontSize: 13 }}>
            {t('settings.keys.conflicts', { count: conflicts.length })}
          </div>
        ) : null}
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <tbody>
            {KEY_ACTIONS.map((a) => (
              <KeybindRow
                key={a.id}
                actionId={a.id}
                labelKey={a.labelKey}
                capturing={capturing === a.id}
                onCapture={setCapturing}
              />
            ))}
          </tbody>
        </table>
      </section>

      <AccountCenterSection />
      <HarnessSection />
      <MachinesSection />
      <AgentPermissionsSection />

      <section className="tn-card" style={{ padding: 16 }}>
        <h2 style={{ margin: '0 0 8px', fontSize: 16 }}>{t('settings.layout.title')}</h2>
        <p style={{ fontSize: 12, color: 'var(--tn-fg-muted)' }}>
          {layoutSync.enabled
            ? t('settings.layout.synced')
            : t('settings.layout.deviceLocal', { code: layoutSync.reasonCode })}
        </p>
        {Object.keys(layout.templates).length === 0 ? (
          <div style={{ color: 'var(--tn-fg-muted)' }}>{t('settings.layout.none')}</div>
        ) : (
          Object.values(layout.templates).map((tpl) => (
            <div
              key={tpl.name}
              style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0' }}
            >
              <span style={{ flex: 1 }}>{tpl.name}</span>
              <span style={{ fontSize: 12, color: 'var(--tn-fg-faint)' }}>
                {new Date(tpl.savedAt).toLocaleString()}
              </span>
              <button
                type="button"
                className="tn-btn"
                onClick={() => void layout.deleteTemplate(tpl.name)}
              >
                {t('common.delete')}
              </button>
            </div>
          ))
        )}
      </section>
    </div>
  );
}
