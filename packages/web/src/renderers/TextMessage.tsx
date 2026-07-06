/**
 * Seed renderer #1 — user/assistant text bubbles (kind 'message').
 * Prose is rendered through the safe markdown subset (RichText); raw hook
 * tags that leak into a bubble (e.g. `<task-notification>`, injected by the
 * harness, never authored by the user or the model) are swapped for a muted
 * chip instead of dumping literal XML into the conversation.
 */
import type { ReactElement } from 'react';
import type { RendererProps } from './registry';
import { RichText } from './parts/RichText';
import { Chip } from './parts/Chip';

// Kebab-case tag opener (2+ words), e.g. <task-notification>, <system-reminder>.
// Deliberately excludes single-word tags (<div>, <b>, …) so real HTML/markdown
// a user actually typed is left alone — only harness-shaped hook tags match.
const HOOK_TAG_RE = /^<([a-z]+(?:-[a-z]+)+)>/;

function isHookTag(text: string): boolean {
  return HOOK_TAG_RE.test(text.trim());
}

export function TextMessage({ item, ctx }: RendererProps): ReactElement {
  const mine = item.role === 'user';
  const text = item.text ?? '';
  const hookTag = isHookTag(text);
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
        {hookTag ? <Chip>{ctx.t('chat.system.hookTag')}</Chip> : <RichText text={text} />}
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
