/**
 * AttentionSection render tests (M9 W7/W8 — inline answer render). The
 * honesty-critical renders: a GET-seeded confirmation shows INLINE 승인/거절
 * (no WS event needed), an ask with options renders each option button plus
 * the free-text answer, an accepted answer shows its real delivery state (the
 * item stays until ask.answered), and a failed resolve keeps the row with the
 * machine code visible. Static markup via react-dom/server (no jsdom); the
 * connection store hook is re-pointed at live getState() per the established
 * pattern.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import i18n from '../i18n';
import ko from '../i18n/locales/ko.json';
import { useConnectionStore, type AttentionItem } from '../stores/connection';
import { AttentionSection } from './AttentionSection';

vi.mock('../stores/connection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../stores/connection')>();
  const real = actual.useConnectionStore;
  const live = Object.assign(
    (selector?: (s: ReturnType<typeof real.getState>) => unknown) =>
      selector ? selector(real.getState()) : real.getState(),
    real,
  ) as unknown as typeof real;
  return { ...actual, useConnectionStore: live };
});

beforeAll(async () => {
  if (!i18n.isInitialized) {
    await new Promise<void>((resolve) => i18n.on('initialized', () => resolve()));
  }
});

afterEach(() => {
  useConnectionStore.setState({ wsStatus: 'offline', seq: 0, hostConnected: null, attention: [] });
});

function render(): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <AttentionSection />
    </MemoryRouter>,
  );
}

function confirmation(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    key: 'confirm:c-1',
    kind: 'confirmation',
    refId: 'c-1',
    ts: 1111,
    summary: 'harness.write_danger',
    ...overrides,
  };
}

describe('AttentionSection inline answers', () => {
  it('a seeded confirmation renders inline approve/deny (GET-seed, no WS needed)', () => {
    useConnectionStore.getState().seedConfirmations([
      { id: 'c-1', action: 'harness.write_danger', actor: 'agent', params: {}, createdAt: 1 },
    ]);
    const html = render();
    expect(html).toContain(ko.home.attention.kind.confirmation);
    expect(html).toContain('harness.write_danger');
    expect(html).toContain(ko.inbox.approve);
    expect(html).toContain(ko.inbox.deny);
  });

  it('an ask renders its option buttons plus the free-text answer input', () => {
    useConnectionStore.setState({
      attention: [
        {
          key: 'ask:a-1',
          kind: 'ask',
          refId: 'a-1',
          sessionId: 's-1',
          ts: 2222,
          summary: '어느 브랜치로 진행할까요?',
          options: ['main', 'dev'],
        },
      ],
    });
    const html = render();
    expect(html).toContain('어느 브랜치로 진행할까요?');
    expect(html).toContain('main');
    expect(html).toContain('dev');
    expect(html).toContain(ko.attention.answerPlaceholder);
    expect(html).toContain(ko.attention.answerSend);
  });

  it('an accepted answer shows its honest delivery state instead of the form', () => {
    useConnectionStore.setState({
      attention: [
        {
          key: 'ask:a-1',
          kind: 'ask',
          refId: 'a-1',
          sessionId: 's-1',
          ts: 2222,
          answerState: 'delivered',
        },
      ],
    });
    const html = render();
    expect(html).toContain(ko.composer.state.delivered);
    expect(html).not.toContain(ko.attention.answerSend);
  });

  it('a failed resolve keeps the row actionable with the machine code visible', () => {
    useConnectionStore.setState({ attention: [confirmation({ errorCode: 'internal' })] });
    const html = render();
    expect(html).toContain(ko.inbox.approve);
    expect(html).toContain('internal');
  });

  it('empty list renders the honest empty note', () => {
    expect(render()).toContain(ko.home.attention.empty);
  });
});
