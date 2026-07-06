/**
 * Grep tool card — the search pattern plus, when a `path` or `glob` scope is
 * given, a scope chip. Honest by construction: a missing pattern renders
 * "확인 중"; an absent scope simply omits the chip (never fabricated).
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

export function GrepCard({ item, ctx }: RendererProps): ReactElement {
  const input = inputOf(item.raw);
  const pattern = strField(input, 'pattern');
  const path = strField(input, 'path');
  const glob = strField(input, 'glob');
  const scope = path ?? glob;

  return (
    <ToolCardShell
      icon="search"
      eyebrow={ctx.t('chat.toolLabel.Grep')}
      title={
        pattern !== undefined ? (
          <code className="tn-inline-code">{pattern}</code>
        ) : (
          ctx.t('chat.field.checking')
        )
      }
      badges={
        scope !== undefined ? (
          <Chip>
            {ctx.t('chat.grep.scope')}: {scope}
          </Chip>
        ) : null
      }
    />
  );
}

registerRenderer({
  id: 'tool.grep',
  match: { kind: 'tool_call', toolName: 'Grep' },
  Component: GrepCard,
});
