/**
 * ToolCardShell — the standard tool/kind card frame every renderer track wraps
 * its content in. A `.tn-card` with a single header row (optional leading Icon,
 * a mono eyebrow label, an optional title, optional badges, and a right-aligned
 * slot for affordances) plus a body for children. Purely structural: it invents
 * no data, only lays out what the caller passes.
 */
import type { ReactElement, ReactNode } from 'react';
import { Icon, type IconName } from '../../components/Icon';

interface ToolCardShellProps {
  icon?: IconName;
  eyebrow: string;
  title?: ReactNode;
  badges?: ReactNode;
  right?: ReactNode;
  children?: ReactNode;
}

export function ToolCardShell({
  icon,
  eyebrow,
  title,
  badges,
  right,
  children,
}: ToolCardShellProps): ReactElement {
  const hasBody = children !== undefined && children !== null && children !== false;
  return (
    <div className="tn-card" style={{ padding: '8px 12px', margin: '4px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {icon ? <Icon name={icon} size={14} /> : null}
        <span className="tn-eyebrow">{eyebrow}</span>
        {title !== undefined && title !== null ? (
          <span style={{ fontSize: 13, color: 'var(--tn-fg)', minWidth: 0 }}>{title}</span>
        ) : null}
        {badges ? (
          <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>{badges}</span>
        ) : null}
        {right !== undefined && right !== null ? (
          <>
            <span style={{ flex: 1 }} />
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>{right}</span>
          </>
        ) : null}
      </div>
      {hasBody ? <div style={{ marginTop: 6 }}>{children}</div> : null}
    </div>
  );
}
