/**
 * FleetHealthLine — the single glanceable health verdict at the very top of the
 * Manage home (ported from the old control tower's fleetHealth + StatusStrip,
 * minus the governance-loop inputs Terminull never adopted): a dead websocket is
 * 연결 끊김 (red), any pending attention/approval is 개입 필요 (amber), otherwise
 * 정상 (green). ALWAYS a StatusDot PLUS a label — never color alone.
 */
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { StatusDot, type StatusDotTone } from '../../renderers/parts/Chip';
import { useConnectionStore } from '../../stores/connection';
import { pendingApprovals, useApprovalsStore } from '../../stores/approvals';
import { computeFleetHealth, type FleetHealthLevel } from '../../stores/fleet';

/** Health level → StatusDot tone (red / amber / green, never color-only). */
const TONE: Record<FleetHealthLevel, StatusDotTone> = {
  offline: 'error',
  attention: 'running',
  ok: 'done',
};

/** Health level → tinted strip background + ink (design-system vars, no hex). */
const WASH: Record<FleetHealthLevel, string> = {
  offline: 'var(--tn-err-wash)',
  attention: 'var(--tn-run-wash)',
  ok: 'var(--tn-ok-wash)',
};
const INK: Record<FleetHealthLevel, string> = {
  offline: 'var(--tn-err)',
  attention: 'var(--tn-run)',
  ok: 'var(--tn-ok)',
};

export function FleetHealthLine(): ReactElement {
  const { t } = useTranslation();
  const wsStatus = useConnectionStore((s) => s.wsStatus);
  const attentionCount = useConnectionStore((s) => s.attention.length);
  const approvalCount = useApprovalsStore((s) => pendingApprovals(s.entries).length);
  const level = computeFleetHealth({ wsStatus, attentionCount: attentionCount + approvalCount });
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 12px',
        borderRadius: 'var(--tn-radius)',
        background: WASH[level],
        color: INK[level],
      }}
    >
      <StatusDot tone={TONE[level]} />
      <span style={{ fontWeight: 600, fontSize: 14 }}>{t(`fleet.health.${level}`)}</span>
    </div>
  );
}
