/**
 * ExitPlanModeCard resolve + render tests. `t` is the identity-on-key stub,
 * so assertions check for KEY strings.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import '../index';
import './ExitPlanModeCard';
import { resolveRenderer, type RendererContext } from '../registry';
import type { ChatItem } from '../../api/types';
import { ExitPlanModeCard } from './ExitPlanModeCard';

function fakeCtx(): RendererContext {
  return {
    adapterId: 'claude',
    sessionId: 's',
    t: ((k: string) => k) as unknown as RendererContext['t'],
    openDetail() {},
  };
}

function planItem(input: Record<string, unknown>): ChatItem {
  return {
    id: 'p1',
    role: 'agent',
    kind: 'tool_call',
    raw: { semantic: 'tool_use', name: 'ExitPlanMode', input },
  };
}

describe('ExitPlanModeCard', () => {
  it('resolves to tool.exitplanmode for an ExitPlanMode tool_call', () => {
    const item = planItem({ plan: '# Plan\n- step 1' });
    expect(resolveRenderer(item, 'claude').id).toBe('tool.exitplanmode');
  });

  it('renders the plan title and the view-plan button when a plan is present', () => {
    const item = planItem({ plan: '# Plan\n- step 1' });
    const html = renderToStaticMarkup(<ExitPlanModeCard item={item} ctx={fakeCtx()} />);
    expect(html).toContain('chat.plan.title');
    expect(html).toContain('chat.plan.viewPlan');
  });

  it('shows the honest "checking" state and no button when plan is missing', () => {
    const item = planItem({});
    const html = renderToStaticMarkup(<ExitPlanModeCard item={item} ctx={fakeCtx()} />);
    expect(html).toContain('chat.field.checking');
    expect(html).not.toContain('chat.plan.viewPlan');
  });
});
