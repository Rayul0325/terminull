/**
 * GenericItem repaint tests. Static markup via react-dom/server. The dedupe
 * regression needs a `t` that maps role/kind of the same word to the SAME label
 * (mirroring real i18n where chat.role.system and chat.kind.system both resolve
 * to "시스템") — then the fallback must show ONE chip, not two identical ones.
 * Also: distinct role/kind → two chips; a leading hook tag → muted chip (raw tag
 * body never dumped); empty text → the honest noText note.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatItem } from '../api/types';
import { GenericItem } from './GenericItem';
import type { RendererContext } from './registry';

function ctx(over: Record<string, unknown> = {}): RendererContext {
  return {
    adapterId: 'claude',
    sessionId: 's',
    t: (k: string) => k,
    openDetail: () => {},
    ...over,
  } as unknown as RendererContext;
}

describe('GenericItem repaint', () => {
  it('dedupes identical role/kind labels to a SINGLE chip', () => {
    // Mirror real i18n: role.system and kind.system both resolve to "시스템".
    const t = (k: string) => (k === 'chat.role.system' || k === 'chat.kind.system' ? '시스템' : k);
    const item = { id: 'g', role: 'system', kind: 'system', text: '' } as ChatItem;
    const html = renderToStaticMarkup(<GenericItem item={item} ctx={ctx({ t })} />);
    expect(html.match(/class="tn-badge/g) ?? []).toHaveLength(1);
    expect(html.match(/시스템/g) ?? []).toHaveLength(1);
  });

  it('shows two distinct chips for differing role/kind', () => {
    const item = { id: 'g2', role: 'agent', kind: 'event', text: 'x' } as ChatItem;
    const html = renderToStaticMarkup(<GenericItem item={item} ctx={ctx()} />);
    expect(html.match(/class="tn-badge/g) ?? []).toHaveLength(2);
  });

  it('renders a hook-tag chip instead of dumping the raw tag body', () => {
    const item = {
      id: 'g3',
      role: 'system',
      kind: 'event',
      text: '<task-notification>xyz-body</task-notification>',
    } as ChatItem;
    const html = renderToStaticMarkup(<GenericItem item={item} ctx={ctx()} />);
    expect(html).toContain('chat.system.hookTag');
    expect(html).not.toContain('xyz-body');
    expect(html).not.toContain('tn-code');
  });

  it('shows the noText note for an empty item (never invented)', () => {
    const item = { id: 'g4', role: 'agent', kind: 'event', text: '' } as ChatItem;
    const html = renderToStaticMarkup(<GenericItem item={item} ctx={ctx()} />);
    expect(html).toContain('chat.generic.noText');
  });
});
