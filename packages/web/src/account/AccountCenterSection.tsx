/**
 * Account center (M9 W1) — per-tool account cards: honest identity
 * (adapter-reported email/plan, or an explicit 확인 불가 — never blank-green),
 * the profile registry (list / create / delete) and the switch flow. The
 * switch confirm sheet states the two contract facts verbatim: it applies to
 * NEW spawns only, and the N live sessions keep their current account (count
 * shown, sourced from the fleet before the switch and from the server's
 * `liveSessionCount` after). Usage gauges are linked in below the cards.
 * Profiles are pointers at isolated config homes — no credential ever moves.
 */
import { useEffect, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { ToolProfileDto } from '@terminull/shared';
import { pickLocalized } from '../agent/localized';
import { ToolUsageSection } from '../agent/ToolUsageSection';
import type { ToolListEntry } from '../api/types';
import { Sheet } from '../components/Sheet';
import { useAccountsStore } from '../stores/accounts';
import { useFleetStore } from '../stores/fleet';
import {
  DEFAULT_PROFILE,
  activeProfileOf,
  profilesForTool,
  useProfilesStore,
} from '../stores/profiles';
import { useToolsStore } from '../stores/tools';

/** Live sessions of one tool (the pre-switch warning count). */
export function liveSessionCountOf(
  sessions: Array<{ tool: string; live: boolean }>,
  toolId: string,
): number {
  return sessions.filter((s) => s.tool === toolId && s.live).length;
}

/** Identity line — adapter-reported facts or an explicit 확인 불가. */
function IdentityRow({ tool }: { tool: ToolListEntry }): ReactElement {
  const { t, i18n } = useTranslation();
  const entry = useAccountsStore((s) => s.entries[tool.id]);

  // Adapter declares no whoami — honest 확인 불가 without a doomed fetch.
  if (!tool.capabilities.accounts.whoami) {
    return <span className="tn-chip">{t('account.whoami.unavailable')}</span>;
  }
  if (entry === undefined || entry.loading) {
    return <span style={{ fontSize: 12, color: 'var(--tn-fg-muted)' }}>{t('common.loading')}</span>;
  }
  const whoami = entry.account?.whoami;
  if (whoami === undefined || entry.supported === false || whoami.available === false) {
    const reason = whoami !== undefined && whoami.available === false ? whoami.reason : undefined;
    return (
      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="tn-chip">{t('account.whoami.unavailable')}</span>
        {reason !== undefined ? (
          <span style={{ fontSize: 12, color: 'var(--tn-fg-muted)' }}>
            {pickLocalized(reason, i18n.language)}
          </span>
        ) : entry.errorCode !== null ? (
          <code style={{ fontSize: 11, fontFamily: 'var(--tn-font-mono)' }}>{entry.errorCode}</code>
        ) : null}
      </span>
    );
  }
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      <span className="tn-chip">{t('usage.account', { account: whoami.value.account })}</span>
      {whoami.value.plan !== undefined ? (
        <span className="tn-chip">{t('account.whoami.plan', { plan: whoami.value.plan })}</span>
      ) : null}
    </span>
  );
}

/**
 * Switch-confirm sheet body (exported for the render tests): must state the
 * new-spawns-only rule AND the live-session warning count verbatim (contract
 * §5 — the count is shown, sessions are never restarted).
 */
export function SwitchConfirmBody({
  toolName,
  targetLabel,
  liveCount,
  onCancel,
  onConfirm,
}: {
  toolName: string;
  targetLabel: string;
  liveCount: number;
  onCancel: () => void;
  onConfirm: () => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div style={{ fontSize: 14 }}>
        {toolName}
        {' → '}
        <strong>{targetLabel}</strong>
      </div>
      <p style={{ margin: 0, fontSize: 13 }}>{t('account.switch.newSpawnsOnly')}</p>
      <p style={{ margin: 0, fontSize: 13, color: 'var(--tn-warn)' }}>
        {t('account.switch.liveWarning', { count: liveCount })}
      </p>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" className="tn-btn" onClick={onCancel}>
          {t('common.cancel')}
        </button>
        <button type="button" className="tn-btn tn-btn--primary" onClick={onConfirm}>
          {t('account.switch.confirm')}
        </button>
      </div>
    </div>
  );
}

/** Single-column create form (Toss-clean: one field per row, one action). */
function CreateProfileForm({ toolId }: { toolId: string }): ReactElement {
  const { t } = useTranslation();
  const create = useProfilesStore((s) => s.create);
  const [id, setId] = useState('');
  const [label, setLabel] = useState('');
  const [configHome, setConfigHome] = useState('');
  const [errorCode, setErrorCode] = useState<string | null>(null);

  const valid = id.trim() !== '' && label.trim() !== '' && configHome.trim() !== '';
  return (
    <details style={{ marginTop: 8 }}>
      <summary style={{ fontSize: 13, cursor: 'pointer', color: 'var(--tn-fg-muted)' }}>
        {t('account.create.title')}
      </summary>
      <div style={{ display: 'grid', gap: 8, marginTop: 8, maxWidth: 420 }}>
        <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
          {t('account.create.id')}
          <input className="tn-input" value={id} onChange={(e) => setId(e.target.value)} />
        </label>
        <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
          {t('account.create.label')}
          <input className="tn-input" value={label} onChange={(e) => setLabel(e.target.value)} />
        </label>
        <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
          {t('account.create.configHome')}
          <input
            className="tn-input"
            value={configHome}
            onChange={(e) => setConfigHome(e.target.value)}
            placeholder={t('stepper.cwdPlaceholder')}
          />
        </label>
        {errorCode !== null ? (
          <div style={{ color: 'var(--tn-danger)', fontSize: 12 }}>
            {t('account.create.failed', { code: t(`account.error.${errorCode}`, errorCode) })}
          </div>
        ) : null}
        <button
          type="button"
          className="tn-btn tn-btn--primary"
          disabled={!valid}
          onClick={() => {
            const profile: ToolProfileDto = {
              id: id.trim(),
              toolId,
              label: label.trim(),
              configHome: configHome.trim(),
            };
            void create(profile).then((code) => {
              setErrorCode(code);
              if (code === null) {
                setId('');
                setLabel('');
                setConfigHome('');
              }
            });
          }}
        >
          {t('account.create.submit')}
        </button>
      </div>
    </details>
  );
}

/** One per-tool account card (exported for the render tests). */
export function ToolAccountCard({ tool }: { tool: ToolListEntry }): ReactElement {
  const { t, i18n } = useTranslation();
  const profiles = useProfilesStore((s) => s.profiles);
  const active = useProfilesStore((s) => s.active);
  const lastSwitch = useProfilesStore((s) => s.lastSwitch);
  const switchTo = useProfilesStore((s) => s.switchTo);
  const remove = useProfilesStore((s) => s.remove);
  const snapshot = useFleetStore((s) => s.snapshot);
  const loadAccount = useAccountsStore((s) => s.load);

  const [switchTarget, setSwitchTarget] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);

  const whoamiCapable = tool.capabilities.accounts.whoami;
  useEffect(() => {
    if (whoamiCapable) void loadAccount(tool.id);
  }, [tool.id, whoamiCapable, loadAccount]);

  const toolProfiles = profilesForTool(profiles, tool.id);
  const activeId = activeProfileOf(active, tool.id);
  const liveCount = liveSessionCountOf(snapshot?.sessions ?? [], tool.id);

  const rows: Array<{ id: string; label: string; configHome?: string }> = [
    { id: DEFAULT_PROFILE, label: t('account.profiles.default') },
    ...toolProfiles.map((p) => ({ id: p.id, label: p.label, configHome: p.configHome })),
  ];
  const targetLabel = rows.find((r) => r.id === switchTarget)?.label ?? switchTarget ?? '';

  return (
    <div className="tn-card" style={{ padding: '12px 14px', margin: '6px 0' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600 }}>
          {pickLocalized(tool.displayName, i18n.language) ?? tool.id}
        </span>
        <code style={{ fontSize: 11, fontFamily: 'var(--tn-font-mono)' }}>{tool.id}</code>
        <span style={{ flex: 1 }} />
        <IdentityRow tool={tool} />
      </div>

      <div style={{ marginTop: 8 }}>
        <div style={{ fontSize: 12, color: 'var(--tn-fg-muted)', marginBottom: 4 }}>
          {t('account.profiles.title')}
        </div>
        {rows.map((row) => (
          <div
            key={row.id}
            style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0' }}
          >
            <span style={{ fontSize: 13 }}>{row.label}</span>
            {row.configHome !== undefined ? (
              <code
                style={{
                  fontSize: 11,
                  fontFamily: 'var(--tn-font-mono)',
                  color: 'var(--tn-fg-faint)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  maxWidth: 220,
                  whiteSpace: 'nowrap',
                }}
                title={row.configHome}
              >
                {row.configHome}
              </code>
            ) : null}
            <span style={{ flex: 1 }} />
            {row.id === activeId ? (
              <span className="tn-chip" style={{ color: 'var(--tn-ok)' }}>
                {t('account.profiles.active')}
              </span>
            ) : (
              <button
                type="button"
                className="tn-btn"
                onClick={() => {
                  setSwitchError(null);
                  setSwitchTarget(row.id);
                }}
              >
                {t('account.profiles.use')}
              </button>
            )}
            {row.id !== DEFAULT_PROFILE ? (
              <button
                type="button"
                className="tn-btn"
                title={t('account.profiles.deleteNote')}
                onClick={() => void remove(tool.id, row.id)}
              >
                {t('common.delete')}
              </button>
            ) : null}
          </div>
        ))}
        {toolProfiles.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--tn-fg-faint)' }}>
            {t('account.profiles.empty')}
          </div>
        ) : null}
        <CreateProfileForm toolId={tool.id} />
      </div>

      {switchError !== null ? (
        <div style={{ marginTop: 6, color: 'var(--tn-danger)', fontSize: 12 }}>
          {t('account.switch.failed', { code: t(`account.error.${switchError}`, switchError) })}
        </div>
      ) : null}
      {lastSwitch !== null && lastSwitch.toolId === tool.id && switchError === null ? (
        // Post-switch note with the SERVER-reported live count (authoritative).
        <div style={{ marginTop: 6, color: 'var(--tn-fg-muted)', fontSize: 12 }}>
          {t('account.switch.done', { count: lastSwitch.liveSessionCount })}
        </div>
      ) : null}

      <Sheet
        open={switchTarget !== null}
        title={t('account.switch.title')}
        onClose={() => setSwitchTarget(null)}
      >
        <SwitchConfirmBody
          toolName={pickLocalized(tool.displayName, i18n.language) ?? tool.id}
          targetLabel={targetLabel}
          liveCount={liveCount}
          onCancel={() => setSwitchTarget(null)}
          onConfirm={() => {
            const target = switchTarget;
            setSwitchTarget(null);
            if (target === null) return;
            void switchTo(tool.id, target).then((code) => setSwitchError(code));
          }}
        />
      </Sheet>
    </div>
  );
}

export function AccountCenterSection(): ReactElement {
  const { t } = useTranslation();
  const tools = useToolsStore((s) => s.tools);
  const toolsError = useToolsStore((s) => s.errorCode);
  const loadTools = useToolsStore((s) => s.load);
  const profilesError = useProfilesStore((s) => s.errorCode);
  const loadProfiles = useProfilesStore((s) => s.load);

  useEffect(() => {
    void loadTools();
    void loadProfiles();
  }, [loadTools, loadProfiles]);

  return (
    <section className="tn-card" style={{ padding: 16 }}>
      <h2 style={{ margin: '0 0 4px', fontSize: 16 }}>{t('account.title')}</h2>
      <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--tn-fg-faint)' }}>
        {t('account.subtitle')}
      </p>
      {toolsError !== null ? (
        <div style={{ color: 'var(--tn-danger)', fontSize: 13 }}>
          {t('stepper.toolsLoadFailed', { code: toolsError })}
        </div>
      ) : null}
      {profilesError !== null ? (
        <div style={{ color: 'var(--tn-danger)', fontSize: 13 }}>
          {t('account.profiles.loadFailed', { code: profilesError })}
        </div>
      ) : null}
      {tools.map((tool) => (
        <ToolAccountCard key={tool.id} tool={tool} />
      ))}
      {/* Usage gauges linked into the account center (M9 W1). */}
      <div style={{ marginTop: 8 }}>
        <ToolUsageSection />
      </div>
    </section>
  );
}
