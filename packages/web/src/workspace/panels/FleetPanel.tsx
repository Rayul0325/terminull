/**
 * Fleet panel — live+recent sessions from the server snapshot, grouped flat
 * (project grouping lives on the Manage home). Click opens the session panel.
 * Collector failures show per adapter — never silently dropped (server
 * contract: adapters[].error === 'collector_failed').
 *
 * M8 machine awareness: every row shows its machine badge (remote machines),
 * and a session on a stale machine renders as a STALE SNAPSHOT — dimmed, no
 * live dot, an honest "응답 없음 시점의 정보" chip — never as live data.
 */
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { MachinesStrip, machineLabel } from '../../machines/MachinesStrip';
import { SessionRow } from '../../components/fleet/SessionRow';
import { sessionMachineId, useFleetStore } from '../../stores/fleet';
import { LOCAL_MACHINE, useMachinesStore } from '../../stores/machines';
import { useWorkspace } from '../WorkspaceContext';

export function FleetPanel(): ReactElement {
  const { t } = useTranslation();
  const snapshot = useFleetStore((s) => s.snapshot);
  const errorCode = useFleetStore((s) => s.errorCode);
  const machines = useMachinesStore((s) => s.machines);
  const workspace = useWorkspace();

  if (errorCode !== null) {
    return (
      <div style={{ padding: 12, color: 'var(--tn-danger)' }}>
        {t('fleet.loadFailed', { code: errorCode })}
      </div>
    );
  }
  if (!snapshot) {
    return <div style={{ padding: 12, color: 'var(--tn-fg-muted)' }}>{t('common.loading')}</div>;
  }

  const broken = snapshot.adapters.filter((a) => !a.ok);
  return (
    <div style={{ height: '100%', overflow: 'auto', padding: 8 }}>
      <div style={{ padding: '2px 6px' }}>
        <MachinesStrip />
      </div>
      {broken.length > 0 ? (
        <div style={{ color: 'var(--tn-warn)', fontSize: 12, padding: '4px 6px' }}>
          {t('fleet.collectorFailed', { adapters: broken.map((a) => a.adapterId).join(', ') })}
        </div>
      ) : null}
      {snapshot.sessions.length === 0 ? (
        <div style={{ color: 'var(--tn-fg-muted)', padding: 8 }}>{t('fleet.empty')}</div>
      ) : null}
      {snapshot.sessions.map((s) => {
        const machineId = sessionMachineId(s);
        const stale = machines[machineId]?.state === 'stale';
        const machineBadge =
          machineId !== LOCAL_MACHINE ? (
            <span className="tn-badge" title={machineId}>
              {machineLabel(t, machineId, machines[machineId])}
            </span>
          ) : null;
        // The stale-snapshot honesty (dimming, no live dot, staleSnapshot chip)
        // now lives inside SessionRow; the panel keeps its tool chip + explicit
        // rw-attach affordance (M9 W6) in the row's trailing slot.
        return (
          <SessionRow
            key={s.id}
            session={s}
            stale={stale}
            machineBadge={machineBadge}
            onOpen={() => workspace?.openSessionPanel(s.id, s.tool)}
            trailing={
              <>
                <span className="tn-badge" title={s.tool}>
                  {s.tool}
                </span>
                <button
                  type="button"
                  className="tn-btn"
                  style={{ padding: '0 8px', fontSize: 12 }}
                  onClick={() => workspace?.openTerminalPanel(s.id, 'rw')}
                >
                  {t('terminal.attachRw')}
                </button>
              </>
            }
          />
        );
      })}
    </div>
  );
}
