/**
 * Session panel — transcript window + composer + 상세보기 side area.
 *
 * Transcript polling (2.5s, cursor continuation — the proven control-tower
 * cadence) runs only while the panel is mounted; the store keeps at most 8
 * session windows (LRU). tool_use↔tool_result pairing happens here per the
 * registry contract: paired results feed their tool card via ctx.pairedResult
 * and disappear from the flat list.
 */
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { IDockviewPanelProps } from 'dockview';
import { RendererHost, pairToolResults, type DetailView } from '../../renderers';
import type { RendererContext } from '../../renderers';
import { useTranscriptsStore } from '../../stores/transcripts';
import type { SessionPanelParams } from '../panelRegistry';
import { useWorkspace } from '../WorkspaceContext';
import { Composer } from './Composer';
import { DetailPanel } from './DetailPanel';
import { SessionStatusBar } from './SessionStatusBar';

const POLL_MS = 2500;

export function SessionPanel(props: IDockviewPanelProps<SessionPanelParams>): ReactElement {
  const { t } = useTranslation();
  const sessionId = props.params?.sessionId ?? '';
  const adapterId = props.params?.adapterId ?? 'generic-pty';
  const entry = useTranscriptsStore((s) => s.entries[sessionId]);
  const fetchMore = useTranscriptsStore((s) => s.fetchMore);
  const touch = useTranscriptsStore((s) => s.touch);
  const workspace = useWorkspace();
  const [detail, setDetail] = useState<DetailView | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    touch(sessionId);
    void fetchMore(sessionId);
    const timer = setInterval(() => void fetchMore(sessionId), POLL_MS);
    return () => clearInterval(timer);
  }, [sessionId, fetchMore, touch]);

  const items = useMemo(() => entry?.items ?? [], [entry?.items]);
  const pairing = useMemo(() => pairToolResults(items), [items]);

  const baseCtx: Omit<RendererContext, 'pairedResult'> = useMemo(
    () => ({
      adapterId,
      sessionId,
      t,
      openDetail: (view: DetailView) => setDetail(view),
      ...(workspace
        ? { jumpToTerminal: (sid: string) => workspace.openTerminalPanel(sid, 'ro') }
        : {}),
    }),
    [adapterId, sessionId, t, workspace],
  );

  if (!sessionId) {
    return <div style={{ padding: 12, color: 'var(--tn-danger)' }}>{t('session.noId')}</div>;
  }

  return (
    <div style={{ height: '100%', display: 'flex' }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <SessionStatusBar toolId={adapterId} sessionId={sessionId} />
        <div style={{ flex: 1, overflow: 'auto', padding: '8px 12px' }}>
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
          {entry?.truncatedHead ? (
            <div style={{ color: 'var(--tn-fg-faint)', fontSize: 12, textAlign: 'center' }}>
              {t('session.truncatedHead')}
            </div>
          ) : null}
          {entry && entry.supported !== false && items.length === 0 && !entry.loading ? (
            <div style={{ color: 'var(--tn-fg-muted)' }}>{t('session.empty')}</div>
          ) : null}
          {items.map((item) => {
            if (pairing.pairedResultIds.has(item.id)) return null;
            const paired = pairing.resultByCallId.get(item.id);
            const ctx: RendererContext = paired ? { ...baseCtx, pairedResult: paired } : baseCtx;
            return <RendererHost key={item.id} item={item} ctx={ctx} />;
          })}
        </div>
        <Composer sessionId={sessionId} />
      </div>
      {detail ? <DetailPanel view={detail} onClose={() => setDetail(null)} /> : null}
    </div>
  );
}
