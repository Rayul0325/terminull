/**
 * ReasoningView packet tests. Static markup via react-dom/server (fake `t`
 * returns the key). Asserts resolve picks this packet, the body is a COLLAPSED
 * Disclosure with the serif reasoning label, and empty reasoning shows the
 * honest "(내용 없음)" note rather than an empty expander.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatItem } from '../../api/types';
import '../index';
import './ReasoningView';
import { resolveRenderer, type RendererContext } from '../registry';
import { ReasoningView } from './ReasoningView';

function ctx(over: Record<string, unknown> = {}): RendererContext {
  return {
    adapterId: 'claude',
    sessionId: 's',
    t: (k: string) => k,
    openDetail: () => {},
    ...over,
  } as unknown as RendererContext;
}

function re(over: Partial<ChatItem> = {}): ChatItem {
  return {
    id: 'x1',
    role: 'agent',
    kind: 'reasoning',
    text: 'thinking about it',
    ...over,
  } as ChatItem;
}

describe('ReasoningView', () => {
  it('resolves reasoning to kind.reasoning', () => {
    expect(resolveRenderer(re(), 'claude').id).toBe('kind.reasoning');
  });

  it('renders a COLLAPSED disclosure with the serif reasoning label + prose body', () => {
    const html = renderToStaticMarkup(<ReasoningView item={re()} ctx={ctx()} />);
    expect(html).toContain('tn-disclosure');
    expect(html).toContain('tn-serif');
    expect(html).toContain('chat.kind.reasoning');
    expect(html).toContain('thinking about it');
    // defaultOpen=false → React omits the `open` attribute entirely.
    expect(html).not.toContain('<details class="tn-disclosure" open');
  });

  it('shows the empty note when reasoning is blank (never invented)', () => {
    const html = renderToStaticMarkup(<ReasoningView item={re({ text: '' })} ctx={ctx()} />);
    expect(html).toContain('chat.kind.empty');
  });
});
