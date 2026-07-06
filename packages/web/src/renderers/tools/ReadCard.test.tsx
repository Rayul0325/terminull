/**
 * ReadCard resolve + render tests. `t` is the identity-on-key stub, so
 * assertions check for KEY strings, never real translations.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import '../index';
import './ReadCard';
import { resolveRenderer, type RendererContext } from '../registry';
import type { ChatItem } from '../../api/types';
import { ReadCard } from './ReadCard';

function fakeCtx(): RendererContext {
  return {
    adapterId: 'claude',
    sessionId: 's',
    t: ((k: string) => k) as unknown as RendererContext['t'],
    openDetail() {},
  };
}

function readItem(input: Record<string, unknown>): ChatItem {
  return {
    id: 'r1',
    role: 'agent',
    kind: 'tool_call',
    raw: { semantic: 'tool_use', name: 'Read', input },
  };
}

describe('ReadCard', () => {
  it('resolves to tool.read for a Read tool_call', () => {
    const item = readItem({ file_path: '/a/b.ts' });
    expect(resolveRenderer(item, 'claude').id).toBe('tool.read');
  });

  it('renders the path and the range chip when both offset and limit are present', () => {
    const item = readItem({ file_path: '/a/b.ts', offset: 10, limit: 50 });
    const html = renderToStaticMarkup(<ReadCard item={item} ctx={fakeCtx()} />);
    expect(html).toContain('/a/b.ts');
    expect(html).toContain('chat.read.range');
  });

  it('omits the range chip when only one of offset/limit is present (no fabricated interpolation)', () => {
    const item = readItem({ file_path: '/a/b.ts', offset: 10 });
    const html = renderToStaticMarkup(<ReadCard item={item} ctx={fakeCtx()} />);
    expect(html).not.toContain('chat.read.range');
  });

  it('shows the honest "checking" state when file_path is missing', () => {
    const item = readItem({});
    const html = renderToStaticMarkup(<ReadCard item={item} ctx={fakeCtx()} />);
    expect(html).toContain('chat.field.checking');
  });
});
