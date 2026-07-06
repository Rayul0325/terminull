/**
 * Agent permission settings — one clean column of per-action rows, each with a
 * 자동/물어보고/금지 segmented toggle (contract: GET/PUT
 * /api/agent/permission-settings; the server response is the only thing that
 * flips a row). Rows with a floor render the looser options locked with an
 * explanatory caption (session.delete is pinned to >= confirm), and the static
 * notice states the hard rule: the agent can never change these itself.
 */
import { useEffect, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import {
  PERMISSION_CLASSES,
  type PermissionActionDto,
  type PermissionClass,
} from '@terminull/shared';
import { belowFloor, useAgentSettingsStore } from '../stores/agentSettings';

function SegmentedClassToggle({
  row,
  saving,
  onSelect,
}: {
  row: PermissionActionDto;
  saving: boolean;
  onSelect: (cls: PermissionClass) => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <div
      role="radiogroup"
      aria-label={t(row.labelKey, { defaultValue: row.id })}
      style={{
        display: 'inline-flex',
        border: '1px solid var(--tn-border)',
        borderRadius: 'var(--tn-radius-sm)',
        overflow: 'hidden',
        flex: 'none',
      }}
    >
      {PERMISSION_CLASSES.map((cls) => {
        const active = row.class === cls;
        const locked = belowFloor(cls, row.floor);
        return (
          <button
            key={cls}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={saving || locked || active}
            onClick={() => onSelect(cls)}
            style={{
              border: 'none',
              padding: '6px 12px',
              fontSize: 13,
              cursor: saving || locked || active ? 'default' : 'pointer',
              background: active ? 'var(--tn-accent)' : 'var(--tn-bg-elevated)',
              color: active ? 'var(--tn-accent-fg)' : 'var(--tn-fg)',
              opacity: locked ? 0.35 : 1,
            }}
          >
            {t(`settings.agent.class.${cls}`)}
          </button>
        );
      })}
    </div>
  );
}

export function AgentPermissionsSection(): ReactElement {
  const { t } = useTranslation();
  const settings = useAgentSettingsStore((s) => s.settings);
  const errorCode = useAgentSettingsStore((s) => s.errorCode);
  const saveErrorCode = useAgentSettingsStore((s) => s.saveErrorCode);
  const savingIds = useAgentSettingsStore((s) => s.savingIds);
  const load = useAgentSettingsStore((s) => s.load);
  const setClass = useAgentSettingsStore((s) => s.setClass);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="tn-card" style={{ padding: 16 }}>
      <h2 style={{ margin: '0 0 4px', fontSize: 16 }}>{t('settings.agent.title')}</h2>
      {/* Static hard-rule notice — always visible, not tied to load state. */}
      <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--tn-fg-muted)' }}>
        {t('settings.agent.notice')}
      </p>
      {errorCode !== null ? (
        <div style={{ color: 'var(--tn-danger)', fontSize: 13 }}>
          {t('settings.agent.loadFailed', { code: errorCode })}
        </div>
      ) : null}
      {saveErrorCode !== null ? (
        <div style={{ color: 'var(--tn-danger)', fontSize: 13, marginBottom: 8 }}>
          {t('settings.agent.saveFailed', { code: saveErrorCode })}
        </div>
      ) : null}
      {settings === null && errorCode === null ? (
        <div style={{ color: 'var(--tn-fg-muted)' }}>{t('common.loading')}</div>
      ) : null}
      {settings?.actions.map((row) => {
        const saving = savingIds.includes(row.id);
        return (
          <div
            key={row.id}
            style={{ padding: '10px 0', borderBottom: '1px solid var(--tn-border)' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14 }}>{t(row.labelKey, { defaultValue: row.id })}</div>
                <div style={{ display: 'flex', gap: 6, marginTop: 2, flexWrap: 'wrap' }}>
                  <span
                    className="tn-chip"
                    style={row.risk === 'high' ? { color: 'var(--tn-danger)' } : {}}
                  >
                    {t(`settings.agent.risk.${row.risk}`)}
                  </span>
                  {row.requiresTwoStep ? (
                    <span className="tn-chip" style={{ color: 'var(--tn-warn)' }}>
                      {t('settings.agent.twoStep')}
                    </span>
                  ) : null}
                  {saving ? <span className="tn-chip">{t('settings.agent.saving')}</span> : null}
                </div>
              </div>
              <SegmentedClassToggle
                row={row}
                saving={saving}
                onSelect={(cls) => void setClass(row.id, cls)}
              />
            </div>
            {row.floor !== undefined ? (
              <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--tn-fg-faint)' }}>
                {t('settings.agent.floorNote', {
                  floor: t(`settings.agent.class.${row.floor}`),
                })}
              </p>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}
