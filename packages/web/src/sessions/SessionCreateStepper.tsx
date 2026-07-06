/**
 * Session-create stepper (M6 debt, M9 W5) — Toss-clean single-column wizard
 * in a sheet: tool → machine (connected only) → cwd → model (dynamic
 * registry, honest 422 skip) → permission mode (declared capabilities only)
 * → confirm (summary + ACTIVE account-profile badge). Spawns via the
 * contracted POST body; errors surface as machine codes, never silently.
 */
import { useEffect, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { pickLocalized } from '../agent/localized';
import { Sheet } from '../components/Sheet';
import { machineLabel } from '../machines/MachinesStrip';
import { activeProfileOf, useProfilesStore } from '../stores/profiles';
import { STEPS, selectableMachines, useSpawnStepperStore, type StepId } from '../stores/spawnStepper';
import { useMachinesStore } from '../stores/machines';
import { useToolsStore } from '../stores/tools';

/** Confirm-step summary (exported for the render tests). */
export function ConfirmSummary({
  toolName,
  machineName,
  cwd,
  modelLabel,
  permissionMode,
  profileLabel,
}: {
  toolName: string;
  machineName: string;
  cwd: string;
  modelLabel: string;
  permissionMode: string;
  profileLabel: string;
}): ReactElement {
  const { t } = useTranslation();
  const rows: Array<[string, string]> = [
    [t('stepper.step.tool'), toolName],
    [t('stepper.step.machine'), machineName],
    [t('stepper.step.cwd'), cwd],
    [t('stepper.step.model'), modelLabel],
    [t('stepper.step.permission'), permissionMode],
  ];
  return (
    <div style={{ display: 'grid', gap: 4, fontSize: 13 }}>
      {rows.map(([label, value]) => (
        <div key={label} style={{ display: 'flex', gap: 8 }}>
          <span style={{ color: 'var(--tn-fg-muted)', width: 90, flex: 'none' }}>{label}</span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</span>
        </div>
      ))}
      {/* Which account the session will run under (server-side active profile). */}
      <span className="tn-chip" style={{ justifySelf: 'start' }}>
        {t('stepper.profileBadge', { profile: profileLabel })}
      </span>
    </div>
  );
}

function StepDots({ current }: { current: StepId }): ReactElement {
  const { t } = useTranslation();
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8 }}>
      {STEPS.map((step) => (
        <span
          key={step}
          className="tn-chip"
          style={current === step ? { color: 'var(--tn-accent)', fontWeight: 600 } : {}}
        >
          {t(`stepper.step.${step === 'permission' ? 'permission' : step}`)}
        </span>
      ))}
    </div>
  );
}

export function SessionCreateStepper(): ReactElement {
  const { t, i18n } = useTranslation();
  const stepper = useSpawnStepperStore();
  const tools = useToolsStore((s) => s.tools);
  const toolsError = useToolsStore((s) => s.errorCode);
  const loadTools = useToolsStore((s) => s.load);
  const machines = useMachinesStore((s) => s.machines);
  const refreshMachines = useMachinesStore((s) => s.refresh);
  const profiles = useProfilesStore((s) => s.profiles);
  const active = useProfilesStore((s) => s.active);
  const loadProfiles = useProfilesStore((s) => s.load);

  const open = stepper.open;
  useEffect(() => {
    if (!open) return;
    void loadTools();
    void refreshMachines();
    void loadProfiles();
  }, [open, loadTools, refreshMachines, loadProfiles]);

  if (!open) return <></>;

  const tool = tools.find((entry) => entry.id === stepper.toolId);
  const stepIndex = STEPS.indexOf(stepper.step);
  const canNext =
    stepper.step === 'tool'
      ? stepper.toolId !== null
      : stepper.step === 'cwd'
        ? stepper.cwd.trim() !== ''
        : stepper.step !== 'confirm';
  const permissionModes = tool?.capabilities.permissionModes ?? [];
  const activeId = stepper.toolId !== null ? activeProfileOf(active, stepper.toolId) : 'default';
  const profileLabel =
    activeId === 'default'
      ? t('account.profiles.default')
      : (profiles.find((p) => p.toolId === stepper.toolId && p.id === activeId)?.label ?? activeId);

  const body = ((): ReactElement => {
    switch (stepper.step) {
      case 'tool':
        return (
          <div style={{ display: 'grid', gap: 6 }}>
            {toolsError !== null ? (
              <div style={{ color: 'var(--tn-danger)', fontSize: 12 }}>
                {t('stepper.toolsLoadFailed', { code: toolsError })}
              </div>
            ) : null}
            {tools.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className="tn-btn"
                style={
                  stepper.toolId === entry.id
                    ? { borderColor: 'var(--tn-accent)', fontWeight: 600 }
                    : {}
                }
                onClick={() => stepper.selectTool(entry.id)}
              >
                {pickLocalized(entry.displayName, i18n.language) ?? entry.id}
              </button>
            ))}
          </div>
        );
      case 'machine':
        return (
          <div style={{ display: 'grid', gap: 6 }}>
            <p style={{ margin: 0, fontSize: 12, color: 'var(--tn-fg-muted)' }}>
              {t('stepper.machineNote')}
            </p>
            {selectableMachines(machines).map((id) => (
              <button
                key={id}
                type="button"
                className="tn-btn"
                style={
                  stepper.machine === id ? { borderColor: 'var(--tn-accent)', fontWeight: 600 } : {}
                }
                onClick={() => stepper.setMachine(id)}
              >
                {id === 'local' ? t('machines.local') : machineLabel(t, id, machines[id])}
              </button>
            ))}
          </div>
        );
      case 'cwd':
        return (
          <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
            {t('stepper.step.cwd')}
            <input
              className="tn-input"
              value={stepper.cwd}
              placeholder={t('stepper.cwdPlaceholder')}
              onChange={(e) => stepper.setCwd(e.target.value)}
            />
          </label>
        );
      case 'model':
        return (
          <div style={{ display: 'grid', gap: 6 }}>
            {stepper.modelsSupported === false ? (
              <p style={{ margin: 0, fontSize: 12, color: 'var(--tn-fg-muted)' }}>
                {t('stepper.modelUnsupported')}
              </p>
            ) : stepper.modelsErrorCode !== null ? (
              <p style={{ margin: 0, fontSize: 12, color: 'var(--tn-danger)' }}>
                {t('stepper.modelsLoadFailed', { code: stepper.modelsErrorCode })}
              </p>
            ) : stepper.models === null ? (
              <p style={{ margin: 0, fontSize: 12, color: 'var(--tn-fg-muted)' }}>
                {t('common.loading')}
              </p>
            ) : (
              <>
                <button
                  type="button"
                  className="tn-btn"
                  style={
                    stepper.model === null ? { borderColor: 'var(--tn-accent)', fontWeight: 600 } : {}
                  }
                  onClick={() => stepper.setModel(null)}
                >
                  {t('stepper.modelDefault')}
                </button>
                {stepper.models.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className="tn-btn"
                    style={
                      stepper.model === m.id
                        ? { borderColor: 'var(--tn-accent)', fontWeight: 600 }
                        : {}
                    }
                    title={m.id}
                    onClick={() => stepper.setModel(m.id)}
                  >
                    {m.label}
                    <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--tn-fg-faint)' }}>
                      {t(`agent.model.source.${m.source}`)}
                    </span>
                  </button>
                ))}
              </>
            )}
          </div>
        );
      case 'permission':
        return (
          <div style={{ display: 'grid', gap: 6 }}>
            {permissionModes.length === 0 ? (
              <p style={{ margin: 0, fontSize: 12, color: 'var(--tn-fg-muted)' }}>
                {t('stepper.permissionNone')}
              </p>
            ) : (
              <>
                <button
                  type="button"
                  className="tn-btn"
                  style={
                    stepper.permissionMode === null
                      ? { borderColor: 'var(--tn-accent)', fontWeight: 600 }
                      : {}
                  }
                  onClick={() => stepper.setPermissionMode(null)}
                >
                  {t('stepper.permissionDefault')}
                </button>
                {permissionModes.map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className="tn-btn"
                    style={
                      stepper.permissionMode === mode
                        ? { borderColor: 'var(--tn-accent)', fontWeight: 600 }
                        : {}
                    }
                    onClick={() => stepper.setPermissionMode(mode)}
                  >
                    {mode}
                  </button>
                ))}
              </>
            )}
          </div>
        );
      case 'confirm':
        return (
          <div style={{ display: 'grid', gap: 8 }}>
            <ConfirmSummary
              toolName={
                tool !== undefined
                  ? (pickLocalized(tool.displayName, i18n.language) ?? tool.id)
                  : (stepper.toolId ?? '')
              }
              machineName={
                stepper.machine === 'local'
                  ? t('machines.local')
                  : machineLabel(t, stepper.machine, machines[stepper.machine])
              }
              cwd={stepper.cwd}
              modelLabel={
                stepper.model === null
                  ? t('stepper.modelDefault')
                  : (stepper.models?.find((m) => m.id === stepper.model)?.label ?? stepper.model)
              }
              permissionMode={stepper.permissionMode ?? t('stepper.permissionDefault')}
              profileLabel={profileLabel}
            />
            {stepper.spawnErrorCode !== null ? (
              <div style={{ color: 'var(--tn-danger)', fontSize: 12 }}>
                {t('stepper.spawnFailed', {
                  code: t(`machines.error.${stepper.spawnErrorCode}`, stepper.spawnErrorCode),
                })}
              </div>
            ) : null}
            {stepper.created !== null ? (
              <div style={{ color: 'var(--tn-ok)', fontSize: 13 }}>{t('stepper.created')}</div>
            ) : null}
          </div>
        );
    }
  })();

  return (
    <Sheet open={stepper.open} title={t('stepper.title')} onClose={stepper.close}>
      <StepDots current={stepper.step} />
      {body}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
        {stepIndex > 0 && stepper.created === null ? (
          <button
            type="button"
            className="tn-btn"
            onClick={() => stepper.setStep(STEPS[stepIndex - 1]!)}
          >
            {t('stepper.back')}
          </button>
        ) : null}
        {stepper.step !== 'confirm' ? (
          <button
            type="button"
            className="tn-btn tn-btn--primary"
            disabled={!canNext}
            onClick={() => stepper.setStep(STEPS[stepIndex + 1]!)}
          >
            {t('stepper.next')}
          </button>
        ) : stepper.created === null ? (
          <button
            type="button"
            className="tn-btn tn-btn--primary"
            disabled={stepper.spawning}
            onClick={() => void stepper.spawn()}
          >
            {stepper.spawning ? t('stepper.spawning') : t('stepper.spawn')}
          </button>
        ) : (
          <button type="button" className="tn-btn tn-btn--primary" onClick={stepper.close}>
            {t('common.close')}
          </button>
        )}
      </div>
    </Sheet>
  );
}
