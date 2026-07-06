/**
 * kind.reasoning renderer — model "thinking" text, collapsed by default.
 *
 * Reasoning is secondary detail, so it lives behind a Disclosure (collapsed):
 * the summary is the serif reasoning label, the body is the reasoning prose
 * rendered through the XSS-safe RichText subset. Empty reasoning renders the
 * explicit "(내용 없음)" note rather than an empty expander (honest — nothing
 * invented).
 */
import type { ReactElement } from 'react';
import { registerRenderer, type RendererProps } from '../registry';
import { Disclosure } from '../parts/Disclosure';
import { RichText } from '../parts/RichText';

export function ReasoningView({ item, ctx }: RendererProps): ReactElement {
  const text = item.text ?? '';
  return (
    <Disclosure summary={<span className="tn-serif">{ctx.t('chat.kind.reasoning')}</span>}>
      {text.trim().length > 0 ? (
        <RichText text={text} />
      ) : (
        <div style={{ color: 'var(--tn-fg-faint)', fontSize: 12 }}>
          {ctx.t('chat.kind.empty')}
        </div>
      )}
    </Disclosure>
  );
}

registerRenderer({
  id: 'kind.reasoning',
  match: { kind: 'reasoning' },
  Component: ReasoningView,
});
