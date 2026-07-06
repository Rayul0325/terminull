/**
 * Read tool card — target path plus, only when BOTH `offset` and `limit` are
 * present, the requested line-range chip. Honest by construction: a missing
 * path renders "확인 중"; a partial range (only one of the two fields) is
 * never half-interpolated into the template — the chip is simply omitted.
 */
import type { ReactElement } from 'react';
import type { RendererProps } from '../registry';
import { registerRenderer } from '../registry';
import { Chip } from '../parts/Chip';
import { ToolCardShell } from '../parts/ToolCardShell';

function inputOf(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') {
    const input = (raw as Record<string, unknown>)['input'];
    if (input && typeof input === 'object') return input as Record<string, unknown>;
  }
  return {};
}

function strField(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key];
  return typeof v === 'string' ? v : undefined;
}

function numField(input: Record<string, unknown>, key: string): number | undefined {
  const v = input[key];
  return typeof v === 'number' ? v : undefined;
}

export function ReadCard({ item, ctx }: RendererProps): ReactElement {
  const input = inputOf(item.raw);
  const filePath = strField(input, 'file_path');
  const offset = numField(input, 'offset');
  const limit = numField(input, 'limit');
  const hasRange = offset !== undefined && limit !== undefined;

  return (
    <ToolCardShell
      icon="file"
      eyebrow={ctx.t('chat.toolLabel.Read')}
      title={
        filePath !== undefined ? (
          <code className="tn-inline-code">{filePath}</code>
        ) : (
          ctx.t('chat.field.checking')
        )
      }
      badges={hasRange ? <Chip>{ctx.t('chat.read.range', { offset, limit })}</Chip> : null}
    />
  );
}

registerRenderer({
  id: 'tool.read',
  match: { kind: 'tool_call', toolName: 'Read' },
  Component: ReadCard,
});
