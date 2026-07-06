/**
 * Machines rail — one chip per machine with its honest connection state:
 * connected (green), connecting (+attempt count), stale ("마지막 확인 n분 전",
 * never a green dot), disabled. Renders nothing until the server reports
 * machines (pre-registry servers omit the field entirely).
 *
 * With `onSelect` it doubles as a fleet filter (ManageHome): clicking a
 * machine narrows the board to it, clicking again (or "전체") clears.
 */
import { useEffect, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { MachineStateDto } from '../api/types';
import { LOCAL_MACHINE, lastSeenParts, machinesList, useMachinesStore } from '../stores/machines';

const DOT_BY_STATE: Record<string, string> = {
  connected: 'tn-dot--live',
  connecting: 'tn-dot--warn',
  stale: 'tn-dot--down',
  disabled: '',
};

/** Honest per-state chip text; stale always carries the last verified contact. */
export function machineStateText(
  t: (key: string, opts?: Record<string, unknown>) => string,
  machine: MachineStateDto,
  now: number,
): string {
  if (machine.state === 'stale') {
    // The contract guarantees lastSeenAt on stale; the fallback stays honest.
    if (machine.lastSeenAt === null) return t('machines.lastSeen.never');
    const { unit, count } = lastSeenParts(machine.lastSeenAt, now);
    return t(`machines.lastSeen.${unit}`, { count });
  }
  return t(`machines.state.${machine.state}`);
}

/** Display label — 'local' gets the localized name, others their config label. */
export function machineLabel(
  t: (key: string) => string,
  id: string,
  machine: MachineStateDto | undefined,
): string {
  if (id === LOCAL_MACHINE) return t('machines.local');
  return machine?.label ?? id;
}

export function MachinesStrip({
  selected,
  onSelect,
}: {
  /** Currently selected machine id (filter mode); null = all. */
  selected?: string | null;
  /** Present = chips are clickable filters. */
  onSelect?: (id: string | null) => void;
}): ReactElement | null {
  const { t } = useTranslation();
  const machines = useMachinesStore((s) => s.machines);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const list = machinesList(machines);
  if (list.length === 0) return null;
  const interactive = onSelect !== undefined;

  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      <span style={{ fontSize: 12, color: 'var(--tn-fg-faint)' }}>{t('machines.title')}</span>
      {interactive ? (
        <button
          type="button"
          className="tn-chip"
          style={{
            cursor: 'pointer',
            border:
              selected === null || selected === undefined
                ? '1px solid var(--tn-fg-muted)'
                : '1px solid transparent',
          }}
          onClick={() => onSelect?.(null)}
        >
          {t('machines.filterAll')}
        </button>
      ) : null}
      {list.map((m) => {
        const stateText = machineStateText(t, m, now);
        const body = (
          <>
            <span className={`tn-dot ${DOT_BY_STATE[m.state] ?? ''}`} />
            <span>{machineLabel(t, m.id, m)}</span>
            <span
              style={{
                fontSize: 11,
                color: m.state === 'stale' ? 'var(--tn-warn)' : 'var(--tn-fg-faint)',
              }}
            >
              {stateText}
            </span>
            {m.state === 'connecting' && (m.attempts ?? 0) > 0 ? (
              <span style={{ fontSize: 11, color: 'var(--tn-fg-faint)' }}>
                {t('machines.attempts', { count: m.attempts })}
              </span>
            ) : null}
          </>
        );
        if (!interactive) {
          return (
            <span key={m.id} className="tn-chip" title={m.id}>
              {body}
            </span>
          );
        }
        const isSelected = selected === m.id;
        return (
          <button
            type="button"
            key={m.id}
            className="tn-chip"
            title={m.id}
            style={{
              cursor: 'pointer',
              border: isSelected ? '1px solid var(--tn-fg-muted)' : '1px solid transparent',
            }}
            onClick={() => onSelect?.(isSelected ? null : m.id)}
          >
            {body}
          </button>
        );
      })}
    </div>
  );
}
