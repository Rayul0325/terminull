/**
 * TodoWriteCard resolve + render tests. `t` is the identity-on-key stub, so
 * assertions check for KEY strings.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import '../index';
import './TodoWriteCard';
import { resolveRenderer, type RendererContext } from '../registry';
import type { ChatItem } from '../../api/types';
import { TodoWriteCard } from './TodoWriteCard';

function fakeCtx(): RendererContext {
  return {
    adapterId: 'claude',
    sessionId: 's',
    t: ((k: string) => k) as unknown as RendererContext['t'],
    openDetail() {},
  };
}

function todoItem(input: Record<string, unknown>): ChatItem {
  return {
    id: 't1',
    role: 'agent',
    kind: 'tool_call',
    raw: { semantic: 'tool_use', name: 'TodoWrite', input },
  };
}

describe('TodoWriteCard', () => {
  it('resolves to tool.todowrite for a TodoWrite tool_call', () => {
    const item = todoItem({ todos: [] });
    expect(resolveRenderer(item, 'claude').id).toBe('tool.todowrite');
  });

  it('renders each todo with its mapped status label', () => {
    const item = todoItem({
      todos: [
        { content: 'Write EditCard', status: 'completed' },
        { content: 'Write ReadCard', status: 'in_progress' },
        { content: 'Write GrepCard', status: 'pending' },
      ],
    });
    const html = renderToStaticMarkup(<TodoWriteCard item={item} ctx={fakeCtx()} />);
    expect(html).toContain('Write EditCard');
    expect(html).toContain('chat.todo.done');
    expect(html).toContain('Write ReadCard');
    expect(html).toContain('chat.todo.inProgress');
    expect(html).toContain('Write GrepCard');
    expect(html).toContain('chat.todo.pending');
  });

  it('shows an unrecognized status verbatim rather than fabricating a mapped label', () => {
    const item = todoItem({ todos: [{ content: 'Mystery task', status: 'blocked' }] });
    const html = renderToStaticMarkup(<TodoWriteCard item={item} ctx={fakeCtx()} />);
    expect(html).toContain('blocked');
    expect(html).not.toContain('chat.todo.done');
  });

  it('shows the honest empty state when todos is missing or empty', () => {
    const item = todoItem({ todos: [] });
    const html = renderToStaticMarkup(<TodoWriteCard item={item} ctx={fakeCtx()} />);
    expect(html).toContain('chat.todo.empty');
  });
});
