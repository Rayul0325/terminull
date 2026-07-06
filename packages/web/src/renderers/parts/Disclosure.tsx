/**
 * Disclosure — a collapsible section for secondary detail (raw output, full
 * diff, long params). Built on the native <details>/<summary> pair so it works
 * without JavaScript, is keyboard-accessible, and toggles in the browser
 * natively (no controlled state to drift). `defaultOpen` sets the initial state.
 */
import type { ReactElement, ReactNode } from 'react';
import { Icon } from '../../components/Icon';

interface DisclosureProps {
  summary: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}

export function Disclosure({
  summary,
  defaultOpen = false,
  children,
}: DisclosureProps): ReactElement {
  return (
    <details className="tn-disclosure" open={defaultOpen}>
      <summary
        className="tn-disclosure__summary"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          cursor: 'pointer',
          listStyle: 'none',
          color: 'var(--tn-fg-muted)',
          fontSize: 12,
        }}
      >
        <Icon name="caret" size={12} className="tn-disclosure__caret" />
        <span>{summary}</span>
      </summary>
      <div className="tn-disclosure__body" style={{ marginTop: 6 }}>
        {children}
      </div>
    </details>
  );
}
