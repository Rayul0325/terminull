/**
 * MachinesStrip render + machineStateText tests (contract §7, D1). The
 * honesty-critical branch: a STALE machine must show a relative "last seen n
 * ago" (마지막 확인 …) derived from lastSeenParts, NEVER the plain state label
 * ("응답 없음") and NEVER a green/connected dot. Connected machines show the
 * state label + live dot; connecting machines carry their attempt count. No DOM
 * test environment here, so the strip renders to static markup
 * (react-dom/server), and the pure text helper is asserted directly with an
 * injected `now` for deterministic relative text.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '../i18n';
import ko from '../i18n/locales/ko.json';
import type { MachineStateDto } from '../api/types';
import { useMachinesStore } from '../stores/machines';
import { MachinesStrip, machineStateText } from './MachinesStrip';

// renderToStaticMarkup uses React's server-render path, where zustand reads the
// server snapshot (getInitialState()) and ignores setState. Re-point the store
// hook at its LIVE getState() so the strip renders the injected fixtures; every
// other export (machinesList, lastSeenParts, …) and the api methods stay real.
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

const t = i18n.t.bind(i18n) as (key: string, opts?: Record<string, unknown>) => string;

function machine(overrides: Partial<MachineStateDto> = {}): MachineStateDto {
  return { id: 'mars', label: 'Mars', state: 'connected', lastSeenAt: 500, ...overrides };
}

describe('machineStateText', () => {
  const now = 1_000_000_000;

  it('stale renders the relative last-seen text, not the state label', () => {
    const text = machineStateText(
      t,
      machine({ state: 'stale', lastSeenAt: now - 3 * 60_000 }),
      now,
    );
    expect(text).toBe(i18n.t('machines.lastSeen.minutes', { count: 3 }));
    // Never the plain stale label.
    expect(text).not.toBe(ko.machines.state.stale);
  });

  it('stale picks the largest sensible unit (seconds/hours/days)', () => {
    expect(machineStateText(t, machine({ state: 'stale', lastSeenAt: now - 5_000 }), now)).toBe(
      i18n.t('machines.lastSeen.seconds', { count: 5 }),
    );
    expect(
      machineStateText(t, machine({ state: 'stale', lastSeenAt: now - 2 * 3_600_000 }), now),
    ).toBe(i18n.t('machines.lastSeen.hours', { count: 2 }));
    expect(
      machineStateText(t, machine({ state: 'stale', lastSeenAt: now - 5 * 86_400_000 }), now),
    ).toBe(i18n.t('machines.lastSeen.days', { count: 5 }));
  });

  it('stale with a null lastSeenAt falls back honestly to "no contact history"', () => {
    expect(machineStateText(t, machine({ state: 'stale', lastSeenAt: null }), now)).toBe(
      ko.machines.lastSeen.never,
    );
  });

  it('non-stale states use their plain state label', () => {
    expect(machineStateText(t, machine({ state: 'connected' }), now)).toBe(
      ko.machines.state.connected,
    );
    expect(machineStateText(t, machine({ state: 'connecting' }), now)).toBe(
      ko.machines.state.connecting,
    );
    expect(machineStateText(t, machine({ state: 'disabled' }), now)).toBe(
      ko.machines.state.disabled,
    );
  });
});

describe('MachinesStrip render', () => {
  it('renders nothing until the server reports machines', () => {
    expect(renderToStaticMarkup(<MachinesStrip />)).toBe('');
  });

  it('stale machine: down dot, relative last-seen text, no live dot, no state label', () => {
    const lastSeenAt = Date.now() - (5 * 60_000 + 30_000); // 5.5m ago → floors to 5m
    useMachinesStore.setState({ machines: { mars: machine({ state: 'stale', lastSeenAt }) } });
    const html = renderToStaticMarkup(<MachinesStrip />);

    expect(html).toContain('tn-dot--down');
    expect(html).not.toContain('tn-dot--live');
    expect(html).toContain('마지막 확인 5분 전');
    // The plain stale state label must never appear for a stale machine.
    expect(html).not.toContain(ko.machines.state.stale);
    expect(html).toContain('Mars');
  });

  it('connected machine: live dot and the connected state label', () => {
    useMachinesStore.setState({ machines: { mars: machine({ state: 'connected' }) } });
    const html = renderToStaticMarkup(<MachinesStrip />);
    expect(html).toContain('tn-dot--live');
    expect(html).toContain(ko.machines.state.connected);
  });

  it('connecting machine: warn dot with the retry-attempts count', () => {
    useMachinesStore.setState({
      machines: { mars: machine({ state: 'connecting', lastSeenAt: null, attempts: 3 }) },
    });
    const html = renderToStaticMarkup(<MachinesStrip />);
    expect(html).toContain('tn-dot--warn');
    expect(html).toContain(ko.machines.state.connecting);
    expect(html).toContain(i18n.t('machines.attempts', { count: 3 }));
  });

  it('filter mode renders clickable chips including the "전체" clear button', () => {
    useMachinesStore.setState({ machines: { mars: machine({ state: 'connected' }) } });
    const html = renderToStaticMarkup(<MachinesStrip selected={null} onSelect={() => {}} />);
    expect(html).toContain(ko.machines.filterAll);
    expect(html).toContain('<button');
    expect(html).toContain('Mars');
  });
});
