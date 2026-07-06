/**
 * kind.tool_result renderer — a STANDALONE (unpaired) tool_result.
 *
 * Fixes the "cat -n <pre> dump" defect: an unpaired tool_result used to fall
 * through to the generic dump and render as a bare <pre>. Here it renders as a
 * proper ToolCardShell with a bounded CodeBlock of the output; `raw.isError`
 * flips the block to the error tone and adds an honest error chip. Never a bare
 * <pre>, never invented output — an empty result renders the explicit
 * "(내용 없음)" note.
 *
 * (Paired tool_results are consumed by their tool_call card via ctx.pairedResult
 * and hidden from the flat list; this packet only ever sees the unpaired ones.)
 */
import type { ReactElement } from 'react';
import { registerRenderer, type RendererProps } from '../registry';
import { ToolCardShell } from '../parts/ToolCardShell';
import { CodeBlock } from '../parts/CodeBlock';
import { Chip } from '../parts/Chip';

/** True when the tool_result raw payload flags an error (never green-by-default). */
function isErrorResult(raw: unknown): boolean {
  return !!raw && typeof raw === 'object' && (raw as Record<string, unknown>)['isError'] === true;
}

export function ToolResultView({ item, ctx }: RendererProps): ReactElement {
  const text = item.text ?? '';
  const isError = isErrorResult(item.raw);
  return (
    <ToolCardShell
      icon="clipboard"
      eyebrow={ctx.t('chat.kind.toolResult')}
      badges={isError ? <Chip tone="error">{ctx.t('chat.result.error')}</Chip> : null}
    >
      {text.length > 0 ? (
        <CodeBlock text={text} tone={isError ? 'error' : undefined} />
      ) : (
        <div style={{ color: 'var(--tn-fg-faint)', fontSize: 12 }}>{ctx.t('chat.kind.empty')}</div>
      )}
    </ToolCardShell>
  );
}

registerRenderer({
  id: 'kind.toolResult',
  match: { kind: 'tool_result' },
  Component: ToolResultView,
});
