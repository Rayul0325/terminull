/**
 * SystemView packet tests. Static markup via react-dom/server (fake `t` returns
 * the key). The defect-fix regression: a plain system item yields EXACTLY ONE
 * chip (not two identical role/kind chips); the chip keys on raw.subtype when
 * present; and a leading raw hook tag becomes a muted chip instead of leaking
 * the tag body.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatItem } from '../../api/types';
import '../index';
import './SystemView';
import { resolveRenderer, type RendererContext } from '../registry';
import { SystemView } from './SystemView';

function ctx(over: Record<string, unknown> = {}): RendererContext {
  return {
    adapterId: 'claude',
    sessionId: 's',
    t: (k: string) => k,
    openDetail: () => {},
    ...over,
  } as unknown as RendererContext;
}

function sy(over: Partial<ChatItem> = {}): ChatItem {
  return { id: 'sy1', role: 'system', kind: 'system', ...over } as ChatItem;
}

describe('SystemView', () => {
  it('resolves a system item to kind.system', () => {
    expect(resolveRenderer(sy(), 'claude').id).toBe('kind.system');
  });

  it('renders EXACTLY ONE chip for a plain system item (not two identical)', () => {
    const html = renderToStaticMarkup(<SystemView item={sy()} ctx={ctx()} />);
    const chips = html.match(/class="tn-badge/g) ?? [];
    expect(chips).toHaveLength(1);
    expect(html).toContain('chat.kind.system');
  });

  it('keys the single chip on raw.subtype when present', () => {
    const html = renderToStaticMarkup(
      <SystemView item={sy({ raw: { subtype: 'init' } })} ctx={ctx()} />,
    );
    expect(html).toContain('init');
    const chips = html.match(/class="tn-badge/g) ?? [];
    expect(chips).toHaveLength(1);
  });

  it('replaces a leading raw hook tag with a muted chip instead of dumping it', () => {
    const html = renderToStaticMarkup(
      <SystemView
        item={sy({ text: '<system-reminder>secret-body</system-reminder>' })}
        ctx={ctx()}
      />,
    );
    expect(html).toContain('chat.system.hookTag');
    expect(html).not.toContain('secret-body');
  });
});
