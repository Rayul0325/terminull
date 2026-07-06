/**
 * Confirm/detail sheet — a centered dialog on desktop, a bottom sheet at the
 * phone breakpoint (M9 W8). Pure overlay markup with inline styles (project
 * convention); the caller owns all content and actions.
 */
import type { ReactElement, ReactNode } from 'react';
import { useIsPhone } from '../lib/viewport';

export function Sheet({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}): ReactElement | null {
  const phone = useIsPhone();
  if (!open) return null;
  return (
    <div
      role="presentation"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex',
        alignItems: phone ? 'flex-end' : 'center',
        justifyContent: 'center',
        zIndex: 60,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className="tn-card"
        style={{
          width: phone ? '100%' : 'min(440px, calc(100vw - 32px))',
          maxHeight: '80vh',
          overflow: 'auto',
          padding: 16,
          borderRadius: phone ? '12px 12px 0 0' : 'var(--tn-radius, 8px)',
          background: 'var(--tn-bg-elevated)',
        }}
      >
        <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>{title}</h3>
        {children}
      </div>
    </div>
  );
}
