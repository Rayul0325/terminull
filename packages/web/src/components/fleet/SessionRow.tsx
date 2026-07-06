/**
 * SessionRow — one fleet session as a scannable row (ported from the old control
 * tower's SessionRow/displayName/rel): a state dot, a HUMAN title (title → cwd
 * basename → short id, NEVER a bare uuid), a "status · relative-time" subline,
 * and the "지금 뭐 하는 중" one-liner from the session's last activity.
 *
 * Honesty: an absent `lastActivity` renders 확인 중, an unknown timestamp renders
 * — (dash) — never a fabricated value, never green-by-default. Presentational:
 * the caller owns every store read (the `stale` flag, the machine badge) and the
 * open handler, so this component invents nothing.
 */
import type { ReactElement, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { FleetSession } from '../../api/types';
import { Chip, StatusDot, type StatusDotTone } from '../../renderers/parts/Chip';

interface SessionRowProps {
  session: FleetSession;
  /** Last-known snapshot from a machine that stopped responding (dimmed, no live dot). */
  stale?: boolean;
  /** Remote-machine chip, when the caller wants one (built with machineLabel). */
  machineBadge?: ReactNode;
  /** Extra right-aligned affordances (e.g. the FleetPanel rw-attach button). */
  trailing?: ReactNode;
  /** Open handler; when omitted the row renders non-interactive. */
  onOpen?: () => void;
  /** Injected "now" (epoch ms) for deterministic relative-time tests. */
  now?: number;
}

/** Minimal shape of the additive `lastActivity` field (track A) — read defensively. */
interface LastActivity {
  toolName?: string;
  summary?: string;
}

/** Read `session.lastActivity` WITHOUT depending on its (concurrently-authored) type. */
function readLastActivity(session: FleetSession): LastActivity | undefined {
  const raw = (session as { lastActivity?: unknown }).lastActivity;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const toolName = typeof o.toolName === 'string' ? o.toolName : undefined;
  const summary = typeof o.summary === 'string' ? o.summary : undefined;
  if (toolName === undefined && summary === undefined) return undefined;
  return { toolName, summary };
}

/** Human display name — never a bare uuid alone (contract: title → cwd base → short id). */
function displayName(session: FleetSession): string {
  if (session.title && session.title.trim() !== '') return session.title;
  if (session.cwd) {
    const base = session.cwd
      .split('/')
      .filter((p) => p !== '')
      .pop();
    if (base) return base;
  }
  return session.id.slice(0, 8);
}

/** Relative-time i18n parts; unknown timestamp → null (rendered as an honest —). */
function relativeParts(now: number, updatedAt?: number): { key: string; count?: number } | null {
  if (!updatedAt) return null;
  const delta = now - updatedAt;
  if (delta < 60_000) return { key: 'fleet.relative.justNow' };
  if (delta < 3_600_000)
    return { key: 'fleet.relative.minutesAgo', count: Math.floor(delta / 60_000) };
  if (delta < 86_400_000)
    return { key: 'fleet.relative.hoursAgo', count: Math.floor(delta / 3_600_000) };
  return { key: 'fleet.relative.daysAgo', count: Math.floor(delta / 86_400_000) };
}

/** Dot tone + status-label key from liveness and machine staleness (no fabrication). */
function statusOf(
  session: FleetSession,
  stale: boolean,
): { tone: StatusDotTone; labelKey: 'fleet.status.running' | 'fleet.status.idle' } {
  // A stale machine's row is last-known data — never a live/running signal.
  if (stale) return { tone: 'offline', labelKey: 'fleet.status.idle' };
  if (session.live) return { tone: 'running', labelKey: 'fleet.status.running' };
  return { tone: 'idle', labelKey: 'fleet.status.idle' };
}

export function SessionRow({
  session,
  stale = false,
  machineBadge,
  trailing,
  onOpen,
  now = Date.now(),
}: SessionRowProps): ReactElement {
  const { t } = useTranslation();
  const { tone, labelKey } = statusOf(session, stale);
  const name = displayName(session);

  const rel = relativeParts(now, session.updatedAt);
  const relText = rel
    ? rel.count !== undefined
      ? t(rel.key, { count: rel.count })
      : t(rel.key)
    : '—';
  const subline = `${t(labelKey)} · ${relText}`;

  const activity = readLastActivity(session);
  let activityText: string;
  if (!activity) {
    activityText = t('fleet.activity.unknown');
  } else {
    const parts: string[] = [];
    if (activity.toolName) {
      parts.push(t(`chat.toolLabel.${activity.toolName}`, { defaultValue: activity.toolName }));
    }
    if (activity.summary && activity.summary.trim() !== '') parts.push(activity.summary.trim());
    activityText = parts.length > 0 ? parts.join(' · ') : t('fleet.activity.unknown');
  }

  const body = (
    <>
      <StatusDot tone={tone} />
      <span
        style={{
          // min-width guards against the 1-char truncation bug; the name column
          // ellipsizes only past a sane minimum, never squeezed to nothing by
          // trailing chips (which now sit OUTSIDE this column, flex: none).
          minWidth: 120,
          flex: 1,
          display: 'grid',
          gap: 1,
          overflow: 'hidden',
          textAlign: 'left',
        }}
      >
        <span
          style={{
            fontSize: 13,
            color: 'var(--tn-fg)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {name}
        </span>
        <span className="tn-microlabel">{subline}</span>
        <span
          style={{
            fontSize: 11,
            color: 'var(--tn-fg-faint)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {activityText}
        </span>
      </span>
    </>
  );

  const openStyle = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flex: 1,
    minWidth: 0,
    background: 'none',
    border: 'none',
    color: 'inherit',
    font: 'inherit',
    textAlign: 'left',
    padding: 0,
  } as const;

  return (
    <div
      className="tn-session-row"
      style={{
        opacity: stale ? 0.55 : 1,
        // Zero-JS virtualization: off-screen rows skip layout/paint while the
        // intrinsic size keeps the scrollbar honest for 100+ rows.
        contentVisibility: 'auto',
        containIntrinsicSize: 'auto 52px',
      }}
    >
      {onOpen ? (
        <button type="button" onClick={onOpen} style={{ ...openStyle, cursor: 'pointer' }}>
          {body}
        </button>
      ) : (
        <span style={openStyle}>{body}</span>
      )}
      {machineBadge}
      {stale ? <Chip tone="idle">{t('machines.staleSnapshot')}</Chip> : null}
      {trailing}
    </div>
  );
}
