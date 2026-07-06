/**
 * The guaranteed fallback renderer — matches EVERYTHING (empty match). An
 * unknown tool, a future ChatItem kind, or a foreign adapter renders through
 * this instead of breaking the transcript. Honest by construction: it shows
 * role, kind, and whatever text exists; nothing is invented.
 */
import type { ReactElement } from 'react';
import type { RendererProps } from './registry';
import { toolNameOf } from './registry';

const TEXT_CAP = 2000;

export function GenericItem({ item, ctx }: RendererProps): ReactElement {
  const name = toolNameOf(item);
  const text = item.text ?? '';
  return (
    <div className="tn-card" style={{ padding: '8px 12px', margin: '4px 0' }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <span className="tn-chip">{ctx.t(`chat.role.${item.role}`, item.role)}</span>
        <span className="tn-chip">{ctx.t(`chat.kind.${item.kind}`, item.kind)}</span>
        {name !== undefined ? <span className="tn-chip">{name}</span> : null}
      </div>
      {text.length > 0 ? (
        <pre
          style={{
            margin: '6px 0 0',
            whiteSpace: 'pre-wrap',
            fontFamily: 'var(--tn-font-mono)',
            fontSize: 12,
            color: 'var(--tn-fg-muted)',
          }}
        >
          {text.length > TEXT_CAP ? text.slice(0, TEXT_CAP) : text}
        </pre>
      ) : (
        <div style={{ color: 'var(--tn-fg-faint)', fontSize: 12, marginTop: 4 }}>
          {ctx.t('chat.generic.noText')}
        </div>
      )}
      {text.length > TEXT_CAP ? (
        <div style={{ color: 'var(--tn-fg-faint)', fontSize: 12 }}>
          {ctx.t('chat.generic.truncated')}
        </div>
      ) : null}
    </div>
  );
}
