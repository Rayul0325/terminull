/**
 * Agent/Task tool card — a subagent launch. Shows the description and, when
 * present, the subagent_type badge plus a truncated prompt preview. This
 * packet self-registers TWICE (one Component, two RendererSpecs) because
 * Claude has used both 'Agent' and 'Task' as the tool name for the same
 * subagent-dispatch semantics across versions — an intentional, documented
 * exception to "one packet registers once" so neither name falls through to
 * the generic card. Honest by construction: an empty prompt renders the
 * explicit "(지시 없음)" state, never a fabricated instruction.
 */
import type { ReactElement } from 'react';
import type { RendererProps } from '../registry';
import { registerRenderer, toolNameOf } from '../registry';
import { Chip } from '../parts/Chip';
import { CodeBlock } from '../parts/CodeBlock';
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

/** Prompt preview cap; the raw event JSON is always available via 상세보기 elsewhere. */
const PROMPT_CAP = 600;

export function AgentCard({ item, ctx }: RendererProps): ReactElement {
  const input = inputOf(item.raw);
  const description = strField(input, 'description');
  const subagentType = strField(input, 'subagent_type');
  const prompt = strField(input, 'prompt');
  const toolName = toolNameOf(item) === 'Task' ? 'Task' : 'Agent';

  return (
    <ToolCardShell
      icon="robot"
      eyebrow={ctx.t(`chat.toolLabel.${toolName}`)}
      title={description ?? ctx.t('chat.field.checking')}
      badges={subagentType !== undefined ? <Chip>{subagentType}</Chip> : null}
    >
      {prompt !== undefined ? (
        <CodeBlock text={prompt} cap={PROMPT_CAP} maxHeight={160} />
      ) : (
        <span style={{ color: 'var(--tn-fg-faint)', fontSize: 12 }}>
          {ctx.t('chat.agent.noPrompt')}
        </span>
      )}
    </ToolCardShell>
  );
}

registerRenderer({
  id: 'tool.agent',
  match: { kind: 'tool_call', toolName: 'Agent' },
  Component: AgentCard,
});

registerRenderer({
  id: 'tool.agent.task',
  match: { kind: 'tool_call', toolName: 'Task' },
  Component: AgentCard,
});
