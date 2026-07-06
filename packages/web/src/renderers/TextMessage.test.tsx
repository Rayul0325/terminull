/**
 * TextMessage render test — static markup via react-dom/server (no jsdom).
 * Covers the two honesty-critical behaviors: prose goes through RichText
 * (so **bold** actually renders as markup, not literal asterisks), and a
 * hook-injected tag never leaks into the bubble as raw XML — it becomes the
 * muted "system notice" chip instead.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatItem } from '../api/types';
import i18n from '../i18n';
import { TextMessage } from './TextMessage';
import type { RendererContext } from './registry';

const ctx: RendererContext = {
  adapterId: 'claude',
  sessionId: 'test-session',
  t: i18n.t.bind(i18n),
  openDetail: () => {},
};

function agentMessage(text: string): ChatItem {
  return { id: 'm1', role: 'agent', kind: 'message', text };
}

describe('TextMessage', () => {
  it('renders **bold** prose as a <b> element via RichText', () => {
    const html = renderToStaticMarkup(<TextMessage item={agentMessage('a **bold** b')} ctx={ctx} />);
    expect(html).toContain('<b>bold</b>');
  });

  it('renders a leaked <task-notification> tag as the muted hook-tag chip, not raw XML', () => {
    const html = renderToStaticMarkup(
      <TextMessage
        item={agentMessage('<task-notification>internal payload</task-notification>')}
        ctx={ctx}
      />,
    );
    expect(html).not.toContain('task-notification');
    expect(html).toContain('tn-badge');
    expect(html).toContain(i18n.t('chat.system.hookTag'));
  });

  it('renders a leaked <system-reminder> tag as the muted hook-tag chip too', () => {
    const html = renderToStaticMarkup(
      <TextMessage item={agentMessage('<system-reminder>ctx</system-reminder>')} ctx={ctx} />,
    );
    expect(html).not.toContain('system-reminder');
    expect(html).toContain(i18n.t('chat.system.hookTag'));
  });

  it('does NOT treat a plain single-word tag as a hook tag (real content stays real content)', () => {
    const html = renderToStaticMarkup(<TextMessage item={agentMessage('<div>hi</div>')} ctx={ctx} />);
    // Escaped by RichText (never live markup), but NOT swapped for the chip.
    expect(html).not.toContain(i18n.t('chat.system.hookTag'));
    expect(html).toContain('&lt;div&gt;');
  });
});
