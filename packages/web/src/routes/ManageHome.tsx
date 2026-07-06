/**
 * Manage home (/) — the Toss-style single-glance surface: status strip,
 * "지금 확인이 필요한 일" attention list, and the fleet board grouped by
 * project. The attention list mirrors stream events since connect — pre-
 * connect backlog needs a server projection endpoint (follow-up), and the
 * section says so instead of implying completeness. The supervisor chat and
 * new-session stepper are later M6 packets — not faked here.
 */
import { useState, type ReactElement } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ApprovalsInbox } from '../agent/ApprovalsInbox';
import { AttentionSection } from '../inbox/AttentionSection';
import { SessionCreateStepper } from '../sessions/SessionCreateStepper';
import { useSpawnStepperStore } from '../stores/spawnStepper';
import { MachinesStrip, machineLabel } from '../machines/MachinesStrip';
import { FleetHealthLine } from '../components/fleet/FleetHealthLine';
import { ProjectGroup } from '../components/fleet/ProjectGroup';
import { SessionRow } from '../components/fleet/SessionRow';
import { groupByProject, projectIdOf, sessionMachineId, useFleetStore } from '../stores/fleet';
import { LOCAL_MACHINE, useMachinesStore } from '../stores/machines';
import { useConnectionStore } from '../stores/connection';

function StatusStrip(): ReactElement {
  const { t } = useTranslation();
  const wsStatus = useConnectionStore((s) => s.wsStatus);
  const hostConnected = useConnectionStore((s) => s.hostConnected);
  const seq = useConnectionStore((s) => s.seq);
  const wsDot =
    wsStatus === 'online'
      ? 'tn-dot--live'
      : wsStatus === 'offline'
        ? 'tn-dot--down'
        : 'tn-dot--warn';
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <span className="tn-chip">
        <span className={`tn-dot ${wsDot}`} />
        {t(`conn.ws.${wsStatus}`)}
      </span>
      <span className="tn-chip">
        <span
          className={`tn-dot ${
            hostConnected === null ? '' : hostConnected ? 'tn-dot--live' : 'tn-dot--down'
          }`}
        />
        {hostConnected === null
          ? t('conn.host.unknown')
          : hostConnected
            ? t('conn.host.up')
            : t('conn.host.down')}
      </span>
      <span className="tn-chip">{t('conn.seq', { seq })}</span>
    </div>
  );
}

export function ManageHome(): ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const snapshot = useFleetStore((s) => s.snapshot);
  const errorCode = useFleetStore((s) => s.errorCode);
  const machines = useMachinesStore((s) => s.machines);
  // Machine filter (M8) — sits alongside the cwd grouping: pick a machine in
  // the strip and the project groups below narrow to that machine's sessions.
  const [machineFilter, setMachineFilter] = useState<string | null>(null);
  const visibleSessions = (snapshot?.sessions ?? []).filter(
    (s) => machineFilter === null || sessionMachineId(s) === machineFilter,
  );
  const groups = snapshot ? [...groupByProject(visibleSessions).entries()] : [];
  const brokenAdapters = snapshot?.adapters.filter((a) => !a.ok) ?? [];

  return (
    <div style={{ maxWidth: 1080, margin: '0 auto', padding: 16, display: 'grid', gap: 12 }}>
      <FleetHealthLine />
      <StatusStrip />
      <AttentionSection />
      <ApprovalsInbox />
      <section className="tn-card" style={{ padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <h2 style={{ margin: '0 0 8px', fontSize: 16 }}>{t('home.fleet.title')}</h2>
          {snapshot ? (
            <span style={{ fontSize: 12, color: 'var(--tn-fg-faint)' }}>
              {t('home.fleet.generatedAt', {
                time: new Date(snapshot.generatedAt).toLocaleTimeString(),
              })}
            </span>
          ) : null}
          <span style={{ flex: 1 }} />
          <button
            type="button"
            className="tn-btn tn-btn--primary"
            onClick={() => useSpawnStepperStore.getState().openStepper()}
          >
            {t('stepper.open')}
          </button>
          <Link to="/workspace/all" className="tn-btn">
            {t('home.fleet.openWorkspace')}
          </Link>
        </div>
        <div style={{ margin: '4px 0 8px' }}>
          <MachinesStrip selected={machineFilter} onSelect={setMachineFilter} />
        </div>
        {errorCode !== null ? (
          <div style={{ color: 'var(--tn-danger)' }}>
            {t('fleet.loadFailed', { code: errorCode })}
          </div>
        ) : null}
        {brokenAdapters.length > 0 ? (
          <div style={{ color: 'var(--tn-warn)', fontSize: 12 }}>
            {t('fleet.collectorFailed', {
              adapters: brokenAdapters.map((a) => a.adapterId).join(', '),
            })}
          </div>
        ) : null}
        {!snapshot && errorCode === null ? (
          <div style={{ color: 'var(--tn-fg-muted)' }}>{t('common.loading')}</div>
        ) : null}
        {snapshot && groups.length === 0 ? (
          <div style={{ color: 'var(--tn-fg-muted)' }}>{t('fleet.empty')}</div>
        ) : null}
        {groups.map(([cwd, sessions]) => {
          // One project node = one cwd-group. A group entirely on a single
          // non-local machine shows ONE header badge; mixed groups fall back to
          // per-row badges so no session's machine is silently hidden.
          const machineIds = new Set(sessions.map(sessionMachineId));
          const groupMachine = machineIds.size === 1 ? [...machineIds][0] : null;
          const anyBusy = sessions.some(
            (s) => s.live && machines[sessionMachineId(s)]?.state !== 'stale',
          );
          const name = cwd
            ? (cwd.split('/').filter((p) => p !== '').pop() ?? cwd)
            : t('home.fleet.unknownProject');
          const headerMachineBadge =
            groupMachine && groupMachine !== LOCAL_MACHINE ? (
              <span className="tn-badge" title={groupMachine}>
                {machineLabel(t, groupMachine, machines[groupMachine])}
              </span>
            ) : null;
          return (
            <ProjectGroup
              key={cwd || 'unknown'}
              name={name}
              fullPath={cwd || undefined}
              anyBusy={anyBusy}
              count={sessions.length}
              machineBadge={headerMachineBadge}
              headerRight={
                <Link
                  to={`/workspace/${projectIdOf(cwd || undefined)}`}
                  className="tn-badge"
                  style={{ textDecoration: 'none' }}
                >
                  {t('home.fleet.openWorkspace')}
                </Link>
              }
            >
              {sessions.map((s) => {
                const machineId = sessionMachineId(s);
                const stale = machines[machineId]?.state === 'stale';
                const rowBadge =
                  groupMachine === null && machineId !== LOCAL_MACHINE ? (
                    <span className="tn-badge" title={machineId}>
                      {machineLabel(t, machineId, machines[machineId])}
                    </span>
                  ) : null;
                return (
                  <SessionRow
                    key={s.id}
                    session={s}
                    stale={stale}
                    machineBadge={rowBadge}
                    onOpen={() => navigate(`/session/${encodeURIComponent(s.id)}`)}
                  />
                );
              })}
            </ProjectGroup>
          );
        })}
      </section>
      <SessionCreateStepper />
    </div>
  );
}
