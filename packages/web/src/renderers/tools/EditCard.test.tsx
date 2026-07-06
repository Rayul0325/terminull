/**
 * EditCard resolve + render tests. Static markup via react-dom/server (no
 * jsdom); `t` is the identity-on-key stub so assertions check for KEY strings
 * (per the shared renderer-track fakeCtx idiom), never real translations.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import '../index'; // built-ins (dedup-safe: ES modules evaluate once)
import './EditCard'; // ensure this packet is registered even before index.ts wires it
import { resolveRenderer, type RendererContext } from '../registry';
import type { ChatItem } from '../../api/types';
import { EditCard } from './EditCard';

function fakeCtx(): RendererContext {
  return {
    adapterId: 'claude',
    sessionId: 's',
    t: ((k: string) => k) as unknown as RendererContext['t'],
    openDetail() {},
  };
}

function editItem(input: Record<string, unknown>): ChatItem {
  return {
    id: 'e1',
    role: 'agent',
    kind: 'tool_call',
    raw: { semantic: 'tool_use', name: 'Edit', input },
  };
}

describe('EditCard', () => {
  it('resolves to tool.edit for an Edit tool_call', () => {
    const item = editItem({ file_path: '/a/b.ts', old_string: 'foo', new_string: 'bar' });
    expect(resolveRenderer(item, 'claude').id).toBe('tool.edit');
  });

  it('renders the path, the diff lines, and the view-diff button — without a paired result', () => {
    const item = editItem({
      file_path: '/a/b.ts',
      old_string: 'line1\nline2',
      new_string: 'line1\nline2-changed',
    });
    const html = renderToStaticMarkup(<EditCard item={item} ctx={fakeCtx()} />);
    expect(html).toContain('/a/b.ts');
    expect(html).toContain('line2');
    expect(html).toContain('line2-changed');
    expect(html).toContain('chat.edit.viewDiff');
  });

  it('shows the honest "no change" state when old_string equals new_string', () => {
    const item = editItem({ file_path: '/a/b.ts', old_string: 'same', new_string: 'same' });
    const html = renderToStaticMarkup(<EditCard item={item} ctx={fakeCtx()} />);
    expect(html).toContain('chat.edit.noChange');
  });

  it('shows the honest "checking" state when input fields are missing', () => {
    const item = editItem({});
    const html = renderToStaticMarkup(<EditCard item={item} ctx={fakeCtx()} />);
    expect(html).toContain('chat.field.checking');
  });
});
