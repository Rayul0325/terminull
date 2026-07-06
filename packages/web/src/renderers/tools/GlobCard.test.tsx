/**
 * GlobCard resolve + render tests. `t` is the identity-on-key stub, so
 * assertions check for KEY strings, never real translations.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import '../index';
import './GlobCard';
import { resolveRenderer, type RendererContext } from '../registry';
import type { ChatItem } from '../../api/types';
import { GlobCard } from './GlobCard';

function fakeCtx(): RendererContext {
  return {
    adapterId: 'claude',
    sessionId: 's',
    t: ((k: string) => k) as unknown as RendererContext['t'],
    openDetail() {},
  };
}

function globItem(input: Record<string, unknown>): ChatItem {
  return {
    id: 'gl1',
    role: 'agent',
    kind: 'tool_call',
    raw: { semantic: 'tool_use', name: 'Glob', input },
  };
}

describe('GlobCard', () => {
  it('resolves to tool.glob for a Glob tool_call', () => {
    const item = globItem({ pattern: '**/*.ts' });
    expect(resolveRenderer(item, 'claude').id).toBe('tool.glob');
  });

  it('renders the pattern and a scope chip when a path is given', () => {
    const item = globItem({ pattern: '**/*.ts', path: 'src/' });
    const html = renderToStaticMarkup(<GlobCard item={item} ctx={fakeCtx()} />);
    expect(html).toContain('**/*.ts');
    expect(html).toContain('chat.glob.scope');
    expect(html).toContain('src/');
  });

  it('omits the scope chip when no path is given', () => {
    const item = globItem({ pattern: '**/*.ts' });
    const html = renderToStaticMarkup(<GlobCard item={item} ctx={fakeCtx()} />);
    expect(html).not.toContain('chat.glob.scope');
  });

  it('shows the honest "checking" state when pattern is missing', () => {
    const item = globItem({});
    const html = renderToStaticMarkup(<GlobCard item={item} ctx={fakeCtx()} />);
    expect(html).toContain('chat.field.checking');
  });
});
