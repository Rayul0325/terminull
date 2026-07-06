/**
 * Mobile shell (M9 W8) — bottom tabs 상태/세션/인박스/관제/계정 with bottom
 * sheets at the phone breakpoint.
 *
 * INVARIANT (documented, load-bearing): the tiled dockview workspace is NEVER
 * mounted on mobile — this module must not import DockWorkspace. Sessions
 * open as full-screen bottom sheets (transcript + composer + statusbar), and
 * the 관제 tab is a board view, not a tiling surface.
 */
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { AccountCenterSection } from '../account/AccountCenterSection';
import { ApprovalsInbox } from '../agent/ApprovalsInbox';
import { AttentionSection } from '../inbox/AttentionSection';
import { MachinesStrip, machineLabel } from '../machines/MachinesStrip';
import { RendererHost, pairToolResults, type DetailView } from '../renderers';
import type { RendererContext } from '../renderers';
import { SessionCreateStepper } from '../sessions/SessionCreateStepper';
import { pendingApprovals, useApprovalsStore } from '../stores/approvals';
import { useConnectionStore } from '../stores/connection';
import { groupByProject, sessionMachineId, useFleetStore } from '../stores/fleet';
import { LOCAL_MACHINE, useMachinesStore } from '../stores/machines';
import { useSpawnStepperStore } from '../stores/spawnStepper';
import { useTranscriptsStore } from '../stores/transcripts';
import { Composer } from '../workspace/panels/Composer';
import { DetailPanel } from '../workspace/panels/DetailPanel';
import { SessionStatusBar } from '../workspace/panels/SessionStatusBar';

export const MOBILE_TABS = ['status', 'sessions', 'inbox', 'ops', 'account'] as const;
export type MobileTab = (typeof MOBILE_TABS)[number];

const POLL_MS = 2500;

/** Full-screen session bottom sheet — transcript + composer, never a tile. */
function MobileSessionSheet({
  sessionId,
  adapterId,
  onClose,
}: {
  sessionId: string;
  adapterId: string;
  onClose: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const entry = useTranscriptsStore((s) => s.entries[sessionId]);
  const fetchMore = useTranscriptsStore((s) => s.fetchMore);
  const touch = useTranscriptsStore((s) => s.touch);
  const [detail, setDetail] = useState<DetailView | null>(null);

  useEffect(() => {
    touch(sessionId);
    void fetchMore(sessionId);
    const timer = setInterval(() => void fetchMore(sessionId), POLL_MS);
    return () => clearInterval(timer);
  }, [sessionId, fetchMore, touch]);

  const items = useMemo(() => entry?.items ?? [], [entry?.items]);
  const pairing = useMemo(() => pairToolResults(items), [items]);
  const baseCtx: Omit<RendererContext, 'pairedResult'> = useMemo(
    () => ({ adapterId, sessionId, t, openDetail: (view: DetailView) => setDetail(view) }),
    [adapterId, sessionId, t],
  );

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--tn-bg)',
      }}
    >
      <div
        className="tn-hairline"
        style={{
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          padding: '8px 12px',
        }}
      >
        <button type="button" className="tn-btn" onClick={onClose}>
          {t('common.close')}
        </button>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {sessionId}
        </span>
      </div>
      <SessionStatusBar toolId={adapterId} sessionId={sessionId} />
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '8px 12px' }}>
        {entry?.supported === false ? (
          <div style={{ color: 'var(--tn-fg-muted)' }}>
            {t('session.noTranscript', { reason: entry.reasonCode ?? '' })}
          </div>
        ) : null}
        {entry?.errorCode ? (
          <div style={{ color: 'var(--tn-danger)', fontSize: 12 }}>
            {t('session.loadError', { code: entry.errorCode })}
          </div>
        ) : null}
        {items.map((item) => {
          if (pairing.pairedResultIds.has(item.id)) return null;
          const paired = pairing.resultByCallId.get(item.id);
          const ctx: RendererContext = paired ? { ...baseCtx, pairedResult: paired } : baseCtx;
          return <RendererHost key={item.id} item={item} ctx={ctx} />;
        })}
      </div>
      <Composer sessionId={sessionId} />
      {detail ? <DetailPanel view={detail} onClose={() => setDetail(null)} /> : null}
    </div>
  );
}

function StatusTab(): ReactElement {
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
    <div style={{ display: 'grid', gap: 8, padding: 12 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
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
      <MachinesStrip />
    </div>
  );
}

function SessionsTab({
  onOpen,
}: {
  onOpen(sessionId: string, adapterId: string): void;
}): ReactElement {
  const { t } = useTranslation();
  const snapshot = useFleetStore((s) => s.snapshot);
  const machines = useMachinesStore((s) => s.machines);
  const sessions = snapshot?.sessions ?? [];
  return (
    <div style={{ display: 'grid', gap: 6, padding: 12 }}>
      <button
        type="button"
        className="tn-btn tn-btn--primary"
        onClick={() => useSpawnStepperStore.getState().openStepper()}
      >
        {t('stepper.open')}
      </button>
      {sessions.length === 0 ? (
        <div style={{ color: 'var(--tn-fg-muted)' }}>{t('mobile.sessionsEmpty')}</div>
      ) : null}
      {sessions.map((s) => {
        const machineId = sessionMachineId(s);
        const machineStale = machines[machineId]?.state === 'stale';
        return (
          <button
            key={s.id}
            type="button"
            className="tn-card"
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              textAlign: 'left',
              padding: '10px 12px',
              opacity: machineStale ? 0.55 : 1,
            }}
            onClick={() => onOpen(s.id, s.tool)}
          >
            <span className={`tn-dot ${s.live && !machineStale ? 'tn-dot--live' : ''}`} />
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {s.title ?? s.id}
            </span>
            {machineId !== LOCAL_MACHINE ? (
              <span className="tn-chip">{machineLabel(t, machineId, machines[machineId])}</span>
            ) : null}
            <span className="tn-chip">{s.tool}</span>
          </button>
        );
      })}
    </div>
  );
}

function OpsTab(): ReactElement {
  const { t } = useTranslation();
  const snapshot = useFleetStore((s) => s.snapshot);
  const groups = snapshot ? [...groupByProject(snapshot.sessions).entries()] : [];
  const broken = snapshot?.adapters.filter((a) => !a.ok) ?? [];
  return (
    <div style={{ display: 'grid', gap: 8, padding: 12 }}>
      {/* Documented invariant: full-screen views instead of tiling on mobile. */}
      <p style={{ margin: 0, fontSize: 12, color: 'var(--tn-fg-faint)' }}>{t('mobile.noTiling')}</p>
      <MachinesStrip />
      {broken.length > 0 ? (
        <div style={{ color: 'var(--tn-warn)', fontSize: 12 }}>
          {t('fleet.collectorFailed', { adapters: broken.map((a) => a.adapterId).join(', ') })}
        </div>
      ) : null}
      {groups.length === 0 ? (
        <div style={{ color: 'var(--tn-fg-muted)' }}>{t('fleet.empty')}</div>
      ) : null}
      {groups.map(([cwd, sessions]) => (
        <div key={cwd || 'unknown'}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>
            {cwd || t('home.fleet.unknownProject')}
            <span className="tn-chip" style={{ marginLeft: 6 }}>
              {t('home.fleet.sessionCount', { count: sessions.length })}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

export function MobileShell({ initialTab = 'status' }: { initialTab?: MobileTab }): ReactElement {
  const { t } = useTranslation();
  const [tab, setTab] = useState<MobileTab>(initialTab);
  const [openSession, setOpenSession] = useState<{ sessionId: string; adapterId: string } | null>(
    null,
  );
  const pendingCount = useApprovalsStore((s) => pendingApprovals(s.entries).length);
  const attentionCount = useConnectionStore((s) => s.attention.length);
  const badge = pendingCount + attentionCount;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <main style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {tab === 'status' ? <StatusTab /> : null}
        {tab === 'sessions' ? (
          <SessionsTab
            onOpen={(sessionId, adapterId) => setOpenSession({ sessionId, adapterId })}
          />
        ) : null}
        {tab === 'inbox' ? (
          <div style={{ display: 'grid', gap: 8, padding: 12 }}>
            <AttentionSection />
            <ApprovalsInbox />
          </div>
        ) : null}
        {tab === 'ops' ? <OpsTab /> : null}
        {tab === 'account' ? (
          <div style={{ padding: 12 }}>
            <AccountCenterSection />
          </div>
        ) : null}
      </main>
      <nav
        style={{
          display: 'flex',
          borderTop: '1px solid var(--tn-border)',
          background: 'var(--tn-bg-elevated)',
        }}
      >
        {MOBILE_TABS.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            style={{
              flex: 1,
              padding: '10px 0',
              background: 'none',
              border: 'none',
              fontSize: 12,
              color: tab === id ? 'var(--tn-accent)' : 'var(--tn-fg-muted)',
              fontWeight: tab === id ? 700 : 400,
              cursor: 'pointer',
            }}
          >
            {t(`mobile.tab.${id}`)}
            {id === 'inbox' && badge > 0 ? (
              <span className="tn-chip" style={{ marginLeft: 4 }}>
                {badge}
              </span>
            ) : null}
          </button>
        ))}
      </nav>
      {openSession !== null ? (
        <MobileSessionSheet
          sessionId={openSession.sessionId}
          adapterId={openSession.adapterId}
          onClose={() => setOpenSession(null)}
        />
      ) : null}
      <SessionCreateStepper />
    </div>
  );
}
