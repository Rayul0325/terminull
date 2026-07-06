/**
 * ToolResultView packet tests. Static markup via react-dom/server (no jsdom, no
 * i18n — a fake `t` returns the key, so assertions target key strings). The
 * defect-fix assertions: a STANDALONE tool_result resolves to this packet and
 * renders as a CARD (not a lone <pre>), an error result carries the error chip +
 * error tone, and a text-less result shows the honest empty note.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatItem } from '../../api/types';
import '../index'; // built-ins (dedup-safe: ES modules evaluate once)
import './ToolResultView'; // self-register this packet
import { resolveRenderer, type RendererContext } from '../registry';
import { ToolResultView } from './ToolResultView';

function ctx(over: Record<string, unknown> = {}): RendererContext {
  return {
    adapterId: 'claude',
    sessionId: 's',
    t: (k: string) => k,
    openDetail: () => {},
    ...over,
  } as unknown as RendererContext;
}

function tr(over: Partial<ChatItem> = {}): ChatItem {
  return {
    id: 'r1',
    role: 'tool',
    kind: 'tool_result',
    text: 'hello output',
    raw: { semantic: 'tool_result', toolUseId: 'x' },
    ...over,
  } as ChatItem;
}

describe('ToolResultView', () => {
  it('resolves a standalone tool_result to kind.toolResult', () => {
    expect(resolveRenderer(tr(), 'claude').id).toBe('kind.toolResult');
  });

  it('renders a card (not a lone <pre>) with a CodeBlock of the text', () => {
    const html = renderToStaticMarkup(<ToolResultView item={tr()} ctx={ctx()} />);
    expect(html).toContain('tn-card');
    expect(html).toContain('tn-code');
    expect(html).toContain('chat.kind.toolResult');
    expect(html).toContain('hello output');
    // The card wraps the <pre> — the block is nested, not standalone.
    expect(html.startsWith('<pre')).toBe(false);
    expect(html.indexOf('tn-card')).toBeLessThan(html.indexOf('tn-code'));
  });

  it('marks an error result with the error chip and error tone', () => {
    const html = renderToStaticMarkup(
      <ToolResultView item={tr({ raw: { semantic: 'tool_result', isError: true } })} ctx={ctx()} />,
    );
    expect(html).toContain('chat.result.error');
    expect(html).toContain('tn-badge--error');
    // CodeBlock error tone uses the error wash background.
    expect(html).toContain('--tn-err-wash');
  });

  it('renders the empty note for a text-less result (never invented)', () => {
    const html = renderToStaticMarkup(<ToolResultView item={tr({ text: '' })} ctx={ctx()} />);
    expect(html).toContain('chat.kind.empty');
    expect(html).not.toContain('tn-code');
  });
});
