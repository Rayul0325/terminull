/**
 * Seed renderer #1 — user/assistant text bubbles (kind 'message').
 * Deliberately plain: markdown rendering for assistant text is its own packet
 * (RENDERERS.md), so raw text here is honest, not lazy.
 */
import type { ReactElement } from 'react';
import type { RendererProps } from './registry';

export function TextMessage({ item, ctx }: RendererProps): ReactElement {
  const mine = item.role === 'user';
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: mine ? 'flex-end' : 'flex-start',
        margin: '4px 0',
      }}
    >
      <div
        className="tn-card"
        style={{
          maxWidth: '78%',
          padding: '8px 12px',
          ...(mine
            ? { background: 'var(--tn-accent)', color: 'var(--tn-accent-fg)', border: 'none' }
            : {}),
        }}
        aria-label={ctx.t(mine ? 'chat.role.user' : 'chat.role.agent')}
      >
        <div style={{ whiteSpace: 'pre-wrap' }}>{item.text ?? ''}</div>
        {item.ts !== undefined ? (
          <div
            style={{
              fontSize: 11,
              opacity: 0.7,
              marginTop: 2,
              textAlign: mine ? 'right' : 'left',
            }}
          >
            {new Date(item.ts).toLocaleTimeString()}
          </div>
        ) : null}
      </div>
    </div>
  );
}
