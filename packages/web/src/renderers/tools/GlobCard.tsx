/**
 * Glob tool card — the file-name pattern plus, when a `path` scope is given,
 * a scope chip. Honest by construction: a missing pattern renders "확인 중";
 * an absent scope simply omits the chip (never fabricated).
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

export function GlobCard({ item, ctx }: RendererProps): ReactElement {
  const input = inputOf(item.raw);
  const pattern = strField(input, 'pattern');
  const path = strField(input, 'path');

  return (
    <ToolCardShell
      icon="folder"
      eyebrow={ctx.t('chat.toolLabel.Glob')}
      title={
        pattern !== undefined ? (
          <code className="tn-inline-code">{pattern}</code>
        ) : (
          ctx.t('chat.field.checking')
        )
      }
      badges={
        path !== undefined ? (
          <Chip>
            {ctx.t('chat.glob.scope')}: {path}
          </Chip>
        ) : null
      }
    />
  );
}

registerRenderer({
  id: 'tool.glob',
  match: { kind: 'tool_call', toolName: 'Glob' },
  Component: GlobCard,
});
