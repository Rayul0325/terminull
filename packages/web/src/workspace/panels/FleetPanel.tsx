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
        const machineStale = machines[machineId]?.state === 'stale';
        return (
          <button
            type="button"
            key={s.id}
            onClick={() => workspace?.openSessionPanel(s.id, s.tool)}
            className="tn-card"
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              width: '100%',
              textAlign: 'left',
              padding: '8px 10px',
              margin: '4px 0',
              cursor: 'pointer',
              border: '1px solid var(--tn-border)',
              // Stale-snapshot state: the machine stopped responding, so this
              // row is last-known data — visibly dimmed, never a live dot.
              opacity: machineStale ? 0.55 : 1,
            }}
          >
            <span className={`tn-dot ${s.live && !machineStale ? 'tn-dot--live' : ''}`} />
            <span
              style={{
                flex: 1,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {s.title ?? s.id}
            </span>
            {machineId !== LOCAL_MACHINE ? (
              <span className="tn-chip" title={machineId}>
                {machineLabel(t, machineId, machines[machineId])}
              </span>
            ) : null}
            <span className="tn-chip">{s.tool}</span>
            {machineStale ? (
              <span className="tn-chip" style={{ color: 'var(--tn-warn)' }}>
                {t('machines.staleSnapshot')}
              </span>
            ) : s.live ? (
              <span className="tn-chip">{t('fleet.live')}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
