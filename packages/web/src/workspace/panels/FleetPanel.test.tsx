/**
 * FleetPanel render tests — the honesty-critical machine treatment (contract
 * §7, D1): a session on a STALE machine must render as a last-known snapshot —
 * dimmed (opacity 0.55), NO live dot even when `s.live` is true, and an honest
 * staleSnapshot chip — never as live data; a session on a CONNECTED machine
 * keeps its live dot. No DOM test environment in this package, so the panel
 * renders to static markup (react-dom/server), mirroring ApprovalsInbox.test.
 * Store state is injected directly (the panel reads it synchronously in
 * render); the throttled REST refetch never runs under renderToStaticMarkup.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '../../i18n';
import ko from '../../i18n/locales/ko.json';
import type { FleetSession, FleetSnapshot, MachineStateDto } from '../../api/types';
import { useFleetStore } from '../../stores/fleet';
import { useMachinesStore } from '../../stores/machines';
import { FleetPanel } from './FleetPanel';

// renderToStaticMarkup takes React's server-render path, where zustand's
// useSyncExternalStore reads the SERVER snapshot (= getInitialState()) and
// ignores setState. Re-point only the two stores these tests inject at their
// LIVE getState() so the panel renders against the fixtures below. Every other
// export (sessionMachineId, machinesList, machineLabel, …) stays real, and the
// api methods (getState/setState) are copied so the tests' setState still hits
// the same singleton.
vi.mock('../../stores/fleet', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/fleet')>();
  const real = actual.useFleetStore;
  const live = Object.assign(
    (selector?: (s: ReturnType<typeof real.getState>) => unknown) =>
      selector ? selector(real.getState()) : real.getState(),
    real,
  ) as unknown as typeof real;
  return { ...actual, useFleetStore: live };
});
vi.mock('../../stores/machines', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/machines')>();
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
  useFleetStore.setState({ snapshot: null, loading: false, errorCode: null });
  useMachinesStore.setState({ machines: {}, loading: false, errorCode: null });
});

function fleetSession(overrides: Partial<FleetSession> = {}): FleetSession {
  return { id: 's-1', tool: 'claude', live: true, origin: 'paneld', ...overrides };
}

function fleetSnapshot(overrides: Partial<FleetSnapshot> = {}): FleetSnapshot {
  return { generatedAt: 1000, adapters: [], sessions: [], ...overrides };
}

function machine(overrides: Partial<MachineStateDto> = {}): MachineStateDto {
  return { id: 'mars', label: 'Mars', state: 'connected', lastSeenAt: 500, ...overrides };
}

function render(): string {
  return renderToStaticMarkup(<FleetPanel />);
}

describe('FleetPanel machine honesty', () => {
  it('stale machine: live session renders dimmed, no live dot, staleSnapshot chip', () => {
    // A live session on a machine that stopped responding — the machine's
    // stale state must win over the session's own `live:true`.
    useMachinesStore.setState({ machines: { mars: machine({ state: 'stale', lastSeenAt: 500 }) } });
    useFleetStore.setState({
      snapshot: fleetSnapshot({
        sessions: [fleetSession({ id: 's-mars', title: 'mars-job', live: true, machine: 'mars' })],
      }),
    });
    const html = render();

    // Dimmed last-known snapshot, and the honest chip.
    expect(html).toContain('opacity:0.55');
    expect(html).toContain(ko.machines.staleSnapshot);
    // No live dot anywhere (the only machine is stale), and NOT the live chip.
    expect(html).not.toContain('tn-dot--live');
    expect(html).not.toContain(ko.fleet.live);
    // Remote machine chip carries the config label.
    expect(html).toContain('Mars');
  });

  it('connected machine: live session keeps its live dot and live chip, not dimmed', () => {
    useMachinesStore.setState({ machines: { mars: machine({ state: 'connected' }) } });
    useFleetStore.setState({
      snapshot: fleetSnapshot({
        sessions: [fleetSession({ id: 's-mars', title: 'mars-job', live: true, machine: 'mars' })],
      }),
    });
    const html = render();

    expect(html).toContain('tn-dot--live');
    expect(html).toContain(ko.fleet.live);
    expect(html).not.toContain(ko.machines.staleSnapshot);
    expect(html).not.toContain('opacity:0.55');
  });

  it('local session has no machine chip and stays live', () => {
    useFleetStore.setState({
      snapshot: fleetSnapshot({
        sessions: [fleetSession({ id: 's-local', title: 'local-job', live: true })],
      }),
    });
    const html = render();
    expect(html).toContain('tn-dot--live');
    expect(html).toContain(ko.fleet.live);
    expect(html).not.toContain(ko.machines.staleSnapshot);
  });

  it('surfaces a broken collector instead of dropping it silently', () => {
    useFleetStore.setState({
      snapshot: fleetSnapshot({
        adapters: [{ adapterId: 'codex', ok: false, error: 'collector_failed', sessions: 0 }],
        sessions: [],
      }),
    });
    const html = render();
    expect(html).toContain('codex');
    expect(html).toContain(ko.fleet.empty);
  });
});
