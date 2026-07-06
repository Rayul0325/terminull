/**
 * AgentCard resolve + render tests, covering BOTH registered tool names
 * ('Agent' and legacy 'Task') sharing the one Component. `t` is the
 * identity-on-key stub, so assertions check for KEY strings.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import '../index';
import './AgentCard';
import { resolveRenderer, type RendererContext } from '../registry';
import type { ChatItem } from '../../api/types';
import { AgentCard } from './AgentCard';

function fakeCtx(): RendererContext {
  return {
    adapterId: 'claude',
    sessionId: 's',
    t: ((k: string) => k) as unknown as RendererContext['t'],
    openDetail() {},
  };
}

function agentItem(name: 'Agent' | 'Task', input: Record<string, unknown>): ChatItem {
  return {
    id: 'a1',
    role: 'agent',
    kind: 'tool_call',
    raw: { semantic: 'tool_use', name, input },
  };
}

describe('AgentCard', () => {
  it('resolves both Agent and Task tool_calls to their registered ids', () => {
    expect(resolveRenderer(agentItem('Agent', {}), 'claude').id).toBe('tool.agent');
    expect(resolveRenderer(agentItem('Task', {}), 'claude').id).toBe('tool.agent.task');
  });

  it('renders description, subagent_type, and the prompt for an Agent call', () => {
    const item = agentItem('Agent', {
      description: 'Explore src/',
      subagent_type: 'Explore',
      prompt: 'Look for the config loader',
    });
    const html = renderToStaticMarkup(<AgentCard item={item} ctx={fakeCtx()} />);
    expect(html).toContain('chat.toolLabel.Agent');
    expect(html).toContain('Explore src/');
    expect(html).toContain('Explore');
    expect(html).toContain('Look for the config loader');
  });

  it('uses the Task tool label when dispatched as Task', () => {
    const item = agentItem('Task', { description: 'Legacy dispatch', prompt: 'do it' });
    const html = renderToStaticMarkup(<AgentCard item={item} ctx={fakeCtx()} />);
    expect(html).toContain('chat.toolLabel.Task');
  });

  it('shows the honest "no prompt" state when prompt is missing', () => {
    const item = agentItem('Agent', { description: 'Explore src/' });
    const html = renderToStaticMarkup(<AgentCard item={item} ctx={fakeCtx()} />);
    expect(html).toContain('chat.agent.noPrompt');
  });
});
