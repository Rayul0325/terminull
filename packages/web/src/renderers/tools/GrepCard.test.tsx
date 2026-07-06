/**
 * GrepCard resolve + render tests. `t` is the identity-on-key stub, so
 * assertions check for KEY strings, never real translations.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import '../index';
import './GrepCard';
import { resolveRenderer, type RendererContext } from '../registry';
import type { ChatItem } from '../../api/types';
import { GrepCard } from './GrepCard';

function fakeCtx(): RendererContext {
  return {
    adapterId: 'claude',
    sessionId: 's',
    t: ((k: string) => k) as unknown as RendererContext['t'],
    openDetail() {},
  };
}

function grepItem(input: Record<string, unknown>): ChatItem {
  return {
    id: 'g1',
    role: 'agent',
    kind: 'tool_call',
    raw: { semantic: 'tool_use', name: 'Grep', input },
  };
}

describe('GrepCard', () => {
  it('resolves to tool.grep for a Grep tool_call', () => {
    const item = grepItem({ pattern: 'TODO' });
    expect(resolveRenderer(item, 'claude').id).toBe('tool.grep');
  });

  it('renders the pattern and a scope chip when a path is given', () => {
    const item = grepItem({ pattern: 'TODO', path: 'src/' });
    const html = renderToStaticMarkup(<GrepCard item={item} ctx={fakeCtx()} />);
    expect(html).toContain('TODO');
    expect(html).toContain('chat.grep.scope');
    expect(html).toContain('src/');
  });

  it('omits the scope chip when neither path nor glob is given', () => {
    const item = grepItem({ pattern: 'TODO' });
    const html = renderToStaticMarkup(<GrepCard item={item} ctx={fakeCtx()} />);
    expect(html).not.toContain('chat.grep.scope');
  });

  it('shows the honest "checking" state when pattern is missing', () => {
    const item = grepItem({});
    const html = renderToStaticMarkup(<GrepCard item={item} ctx={fakeCtx()} />);
    expect(html).toContain('chat.field.checking');
  });
});
