/**
 * GUI statusbar for a session panel — model · context % · cost chips from the
 * statusline-sourced SessionStatusDto (M9 W3). Absent fields render an honest
 * placeholder dash; a session with no status data at all renders a single
 * muted "no data" chip (codex/agy have no statusline source in v1 — their
 * sessions must say so, never invent numbers).
 */
import { useEffect, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { statusKeyOf, useSessionStatusStore } from '../../stores/sessionStatus';

const DASH = '—';

/** Chip value text per field — exported for the render tests. */
export function contextText(dto: { usedPercent: number } | null): string {
  return dto === null ? DASH : `${Math.round(dto.usedPercent)}%`;
}

export function costText(costUsd: number | null): string {
  return costUsd === null ? DASH : `$${costUsd.toFixed(2)}`;
}

export function SessionStatusBar({
  toolId,
  sessionId,
}: {
  toolId: string;
  /** TOOL-NATIVE session id (fleet id space). */
  sessionId: string;
}): ReactElement {
  const { t } = useTranslation();
  const dto = useSessionStatusStore((s) => s.statuses[statusKeyOf(toolId, sessionId)]);
  const seed = useSessionStatusStore((s) => s.seed);

  useEffect(() => {
    if (sessionId) void seed(toolId, sessionId);
  }, [toolId, sessionId, seed]);

  const bar = (children: ReactElement | ReactElement[]): ReactElement => (
    <div
      className="tn-hairline"
      style={{
        display: 'flex',
        gap: 6,
        alignItems: 'center',
        padding: '3px 10px',
        background: 'var(--tn-bg-sunken)',
        fontSize: 12,
        flexWrap: 'wrap',
      }}
    >
      {children}
    </div>
  );

  if (dto === undefined) {
    return bar(
      <span className="tn-chip" style={{ color: 'var(--tn-fg-faint)' }}>
        {t('statusbar.noData')}
      </span>,
    );
  }

  return bar([
    <span key="model" className="tn-chip" title={dto.model?.id ?? ''}>
      <span style={{ color: 'var(--tn-fg-faint)' }}>{t('statusbar.model')}</span>{' '}
      {dto.model?.label ?? DASH}
    </span>,
    <span
      key="context"
      className="tn-chip"
      title={
        dto.contextTokens !== null ? `${dto.contextTokens.used} / ${dto.contextTokens.max}` : ''
      }
    >
      <span style={{ color: 'var(--tn-fg-faint)' }}>{t('statusbar.context')}</span>{' '}
      {contextText(dto.contextTokens)}
    </span>,
    <span key="cost" className="tn-chip">
      <span style={{ color: 'var(--tn-fg-faint)' }}>{t('statusbar.cost')}</span>{' '}
      {costText(dto.costUsd)}
    </span>,
    <span key="asof" style={{ marginLeft: 'auto', color: 'var(--tn-fg-faint)' }}>
      {dto.asOf !== null
        ? t('statusbar.asOf', { time: new Date(dto.asOf).toLocaleTimeString() })
        : ''}
    </span>,
  ]);
}
