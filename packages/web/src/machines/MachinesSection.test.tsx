/**
 * MachinesSection (Settings › Machines) render tests (contract §7, D1): the
 * registry list must show each machine's honest connection state + its last
 * verified contact, and the stale row must carry the relative "마지막 확인 …"
 * text (never the plain "응답 없음" state label). The copyable enroll command
 * is always present (no GUI enroll button by design). No DOM test environment,
 * so it renders to static markup (react-dom/server); the `refresh()` effect and
 * the clock interval never run under renderToStaticMarkup.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '../i18n';
import ko from '../i18n/locales/ko.json';
import type { MachineStateDto } from '../api/types';
import { useMachinesStore } from '../stores/machines';
import { MachinesSection } from './MachinesSection';

// renderToStaticMarkup uses React's server-render path, where zustand reads the
// server snapshot (getInitialState()) and ignores setState. Re-point the store
// hook at its LIVE getState() so the section renders the injected fixtures;
// every other export and the api methods stay real.
vi.mock('../stores/machines', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../stores/machines')>();
  const real = actual.useMachinesStore;
  const live = Object.assign(
    (selector?: (s: ReturnType<typeof real.getState>) => unknown) =>
      selector ? selector(real.getState()) : real.getState(),
    real,
  ) as unknown as typeof real;
  return { ...actual, useMachinesStore: live };
});

beforeAll(async () => {
  if (!i18n.isInitialized) {
    await new Promise<void>((resolve) => i18n.on('initialized', () => resolve()));
  }
});

afterEach(() => {
  useMachinesStore.setState({ machines: {}, loading: false, errorCode: null });
});

function machine(overrides: Partial<MachineStateDto> = {}): MachineStateDto {
  return { id: 'mars', label: 'Mars', state: 'connected', lastSeenAt: 500, ...overrides };
}

function render(): string {
  return renderToStaticMarkup(<MachinesSection />);
}

describe('MachinesSection', () => {
  it('empty registry shows the honest empty note and the enroll command', () => {
    const html = render();
    expect(html).toContain(ko.machines.settings.empty);
    expect(html).toContain('terminull enroll');
    expect(html).toContain(ko.machines.settings.enrollTitle);
  });

  it('renders each machine state with its matching dot and last-seen', () => {
    const staleLastSeen = Date.now() - (5 * 60_000 + 30_000); // 5.5m ago → floors to 5m
    useMachinesStore.setState({
      machines: {
        local: machine({ id: 'local', label: 'local', state: 'connected', lastSeenAt: 1000 }),
        mars: machine({ id: 'mars', label: 'Mars', state: 'stale', lastSeenAt: staleLastSeen }),
        venus: machine({ id: 'venus', label: 'Venus', state: 'disabled', lastSeenAt: null }),
      },
    });
    const html = render();

    // Labels + machine ids both render.
    for (const s of ['Mars', 'Venus', 'mars', 'venus']) expect(html).toContain(s);

    // Per-state dots (connected=live, stale=down, disabled=blank).
    expect(html).toContain('tn-dot--live');
    expect(html).toContain('tn-dot--down');

    // Connected state label + disabled state label render verbatim.
    expect(html).toContain(ko.machines.state.connected);
    expect(html).toContain(ko.machines.state.disabled);

    // Stale row: relative last-seen (lastSeen rendering), NOT the plain label.
    expect(html).toContain('마지막 확인 5분 전');
    expect(html).not.toContain(ko.machines.state.stale);
  });

  it('surfaces a machine load error instead of an empty list', () => {
    useMachinesStore.setState({ errorCode: 'machine_unavailable' });
    const html = render();
    expect(html).toContain('machine_unavailable');
    // Error path does not also claim the list is empty.
    expect(html).not.toContain(ko.machines.settings.empty);
  });
});
