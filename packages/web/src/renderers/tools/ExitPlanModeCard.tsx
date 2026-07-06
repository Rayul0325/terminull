/**
 * ExitPlanMode tool card — the plan-approval request. A "플랜 보기" button opens
 * the full plan markdown in the session side panel via the registry's
 * 'markdown' DetailView kind. Honest by construction: a missing plan string
 * renders "확인 중" and no button (nothing to open).
 */
import type { ReactElement } from 'react';
import type { RendererProps } from '../registry';
import { registerRenderer } from '../registry';
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

export function ExitPlanModeCard({ item, ctx }: RendererProps): ReactElement {
  const input = inputOf(item.raw);
  const plan = strField(input, 'plan');
  const title = ctx.t('chat.plan.title');

  return (
    <ToolCardShell
      icon="clipboard"
      eyebrow={title}
      right={
        plan !== undefined ? (
          <button
            type="button"
            className="tn-btn"
            style={{ padding: '2px 8px', fontSize: 12 }}
            onClick={() =>
              ctx.openDetail({
                id: `plan:${item.id}`,
                title,
                content: { kind: 'markdown', value: plan },
              })
            }
          >
            {ctx.t('chat.plan.viewPlan')}
          </button>
        ) : null
      }
    >
      {plan === undefined ? (
        <span style={{ color: 'var(--tn-fg-faint)', fontSize: 12 }}>
          {ctx.t('chat.field.checking')}
        </span>
      ) : null}
    </ToolCardShell>
  );
}

registerRenderer({
  id: 'tool.exitplanmode',
  match: { kind: 'tool_call', toolName: 'ExitPlanMode' },
  Component: ExitPlanModeCard,
});
