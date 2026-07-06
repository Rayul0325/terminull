/**
 * SidechainView packet tests. Static markup via react-dom/server (fake `t`
 * returns the key). Asserts resolve picks this packet, the divider uses the
 * `.tn-hairline` rule with the sidechain label, and identity is appended when
 * present / the same label stands alone when absent.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatItem } from '../../api/types';
import '../index';
import './SidechainView';
import { resolveRenderer, type RendererContext } from '../registry';
import { SidechainView } from './SidechainView';

function ctx(over: Record<string, unknown> = {}): RendererContext {
  return {
    adapterId: 'claude',
    sessionId: 's',
    t: (k: string) => k,
    openDetail: () => {},
    ...over,
  } as unknown as RendererContext;
}

function sc(over: Partial<ChatItem> = {}): ChatItem {
  return { id: 'sc1', role: 'system', kind: 'sidechain', ...over } as ChatItem;
}

describe('SidechainView', () => {
  it('resolves sidechain to kind.sidechain', () => {
    expect(resolveRenderer(sc(), 'claude').id).toBe('kind.sidechain');
  });

  it('renders a hairline divider with the sidechain label when there is no identity', () => {
    const html = renderToStaticMarkup(<SidechainView item={sc({ text: '' })} ctx={ctx()} />);
    expect(html).toContain('tn-hairline');
    expect(html).toContain('chat.kind.sidechain');
  });

  it('appends the identity after the label when present', () => {
    const html = renderToStaticMarkup(<SidechainView item={sc({ text: 'reviewer' })} ctx={ctx()} />);
    expect(html).toContain('chat.kind.sidechain');
    expect(html).toContain('reviewer');
  });
});
