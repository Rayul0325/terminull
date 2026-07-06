/**
 * SessionStatusBar render tests (M9 W3). The honesty renders: a golden DTO
 * shows model label, rounded context percent, and cost; null fields render the
 * placeholder dash (never a fabricated 0); a session with no DTO at all says
 * "no status data". Static markup (react-dom/server) with the sessionStatus
 * store hook re-pointed at live getState() per the established pattern.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionStatusDto } from '@terminull/shared';
import i18n from '../../i18n';
import ko from '../../i18n/locales/ko.json';
import { statusKeyOf, useSessionStatusStore } from '../../stores/sessionStatus';
import { SessionStatusBar, contextText, costText } from './SessionStatusBar';

vi.mock('../../stores/sessionStatus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/sessionStatus')>();
  const real = actual.useSessionStatusStore;
  const live = Object.assign(
    (selector?: (s: ReturnType<typeof real.getState>) => unknown) =>
      selector ? selector(real.getState()) : real.getState(),
    real,
  ) as unknown as typeof real;
  return { ...actual, useSessionStatusStore: live };
});

beforeAll(async () => {
  if (!i18n.isInitialized) {
    await new Promise<void>((resolve) => i18n.on('initialized', () => resolve()));
  }
});

afterEach(() => {
  useSessionStatusStore.setState({ statuses: {}, seeded: {} });
});

const GOLDEN: SessionStatusDto = {
  toolId: 'claude',
  toolSessionId: 'sess-abc',
  model: { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  contextTokens: { used: 123_456, max: 200_000, usedPercent: 61.7 },
  costUsd: 1.2345,
  asOf: 1_700_000_000_000,
};

function render(toolId = 'claude', sessionId = 'sess-abc'): string {
  return renderToStaticMarkup(<SessionStatusBar toolId={toolId} sessionId={sessionId} />);
}

describe('SessionStatusBar', () => {
  it('renders model · context % · cost chips from the golden DTO', () => {
    useSessionStatusStore.setState({
      statuses: { [statusKeyOf('claude', 'sess-abc')]: GOLDEN },
    });
    const html = render();
    expect(html).toContain(ko.statusbar.model);
    expect(html).toContain('Opus 4.8');
    expect(html).toContain(ko.statusbar.context);
    expect(html).toContain('62%'); // 61.7 rounded, source-reported percent
    expect(html).toContain('$1.23');
    expect(html).not.toContain(ko.statusbar.noData);
  });

  it('null fields render the placeholder dash, never a fabricated zero', () => {
    useSessionStatusStore.setState({
      statuses: {
        [statusKeyOf('claude', 'sess-abc')]: {
          ...GOLDEN,
          model: null,
          contextTokens: null,
          costUsd: null,
          asOf: null,
        },
      },
    });
    const html = render();
    expect(html).toContain('—');
    expect(html).not.toContain('$0');
    expect(html).not.toContain('0%');
  });

  it('a session with no DTO renders the honest no-data chip (codex/agy v1)', () => {
    const html = render('codex', 'sess-x');
    expect(html).toContain(ko.statusbar.noData);
  });

  it('value helpers format honestly', () => {
    expect(contextText(null)).toBe('—');
    expect(contextText({ usedPercent: 61.7 })).toBe('62%');
    expect(costText(null)).toBe('—');
    expect(costText(1.2345)).toBe('$1.23');
  });
});
