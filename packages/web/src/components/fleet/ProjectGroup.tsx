/**
 * ProjectGroup — a collapsible header for one cwd-group of sessions (ported from
 * the old control tower's ProjectGroup). The header carries a caret, the project
 * name, a live dot when any child is busy, an optional machine badge, a session
 * count (t('fleet.group.count')), and an optional right slot (e.g. the per-
 * project workspace link — a SIBLING of the toggle, never nested inside it, so
 * there is no button-in-button a11y trap). Children (the SessionRows) render
 * when open; default-open so the tree is fully expanded on first paint.
 */
import { useState, type ReactElement, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../Icon';
import { StatusDot } from '../../renderers/parts/Chip';

interface ProjectGroupProps {
  name: string;
  /** Full cwd for the header title attribute (hover), when known. */
  fullPath?: string;
  /** True when any session in the group is live (drives the header live dot). */
  anyBusy?: boolean;
  count: number;
  /** Machine chip for a single-machine remote group (caller builds it). */
  machineBadge?: ReactNode;
  /** Right-aligned header slot; a sibling of the toggle button, not nested. */
  headerRight?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}

export function ProjectGroup({
  name,
  fullPath,
  anyBusy = false,
  count,
  machineBadge,
  headerRight,
  defaultOpen = true,
  children,
}: ProjectGroupProps): ReactElement {
  const { t } = useTranslation();
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ margin: '8px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          title={fullPath}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            flex: 1,
            minWidth: 0,
            background: 'none',
            border: 'none',
            color: 'inherit',
            font: 'inherit',
            textAlign: 'left',
            cursor: 'pointer',
            padding: '2px 0',
          }}
        >
          <span
            style={{
              display: 'inline-flex',
              transform: open ? 'rotate(90deg)' : 'none',
              transition: 'transform 0.15s',
            }}
          >
            <Icon name="caret" size={12} />
          </span>
          <span
            style={{
              fontWeight: 600,
              fontSize: 13,
              color: 'var(--tn-fg)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {name}
          </span>
          {anyBusy ? <StatusDot tone="running" /> : null}
        </button>
        {machineBadge}
        <span className="tn-badge">{t('fleet.group.count', { count })}</span>
        {headerRight}
      </div>
      {open ? <div style={{ marginTop: 2 }}>{children}</div> : null}
    </div>
  );
}
