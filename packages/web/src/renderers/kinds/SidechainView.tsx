/**
 * kind.sidechain renderer — a thin labeled divider marking a sub-agent
 * side-channel boundary. It is a structural separator, not a content card: two
 * `.tn-hairline` rules flanking a small centered label. When the sidechain
 * carries an identity (item.text), it is appended after the label; with no
 * identity, the same label stands alone (honest — nothing invented).
 */
import type { ReactElement } from 'react';
import { registerRenderer, type RendererProps } from '../registry';

export function SidechainView({ item, ctx }: RendererProps): ReactElement {
  const identity = (item.text ?? '').trim();
  const label = ctx.t('chat.kind.sidechain');
  return (
    <div
      role="separator"
      style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '10px 0' }}
    >
      <span className="tn-hairline" style={{ flex: 1 }} aria-hidden="true" />
      <span className="tn-microlabel" style={{ color: 'var(--tn-fg-faint)', whiteSpace: 'nowrap' }}>
        {label}
        {identity.length > 0 ? ` · ${identity}` : ''}
      </span>
      <span className="tn-hairline" style={{ flex: 1 }} aria-hidden="true" />
    </div>
  );
}

registerRenderer({
  id: 'kind.sidechain',
  match: { kind: 'sidechain' },
  Component: SidechainView,
});
