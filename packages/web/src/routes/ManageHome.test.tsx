/**
 * ManageHome render tests (contract §7, D1) — the fleet board's machine
 * treatment must match FleetPanel: a session on a STALE machine renders as a
 * last-known snapshot (dimmed, no live dot, staleSnapshot in the title), a
 * connected/remote session shows its machine label, and the machine filter
 * narrows the board to one machine. No DOM test environment in this package, so
 * the route renders to static markup (react-dom/server) inside a MemoryRouter
 * (it uses <Link>/useNavigate). Store state is injected directly; the internal
 * filter is UI state (useState) that renderToStaticMarkup cannot click, so the
 * narrowing predicate is exercised through the exported `sessionMachineId` that
 * the component's inline filter calls.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import i18n from '../i18n';
import ko from '../i18n/locales/ko.json';
import type { FleetSession, FleetSnapshot, MachineStateDto } from '../api/types';
import { sessionMachineId, useFleetStore } from '../stores/fleet';
import { useMachinesStore } from '../stores/machines';
import { ManageHome } from './ManageHome';

// renderToStaticMarkup uses React's server-render path, where zustand reads the
// server snapshot (getInitialState()) and ignores setState. Re-point only the
// two stores these tests inject (fleet + machines) at their LIVE getState();
// the connection/approvals stores keep their empty defaults (no mock needed),
// and every non-hook export stays real.
vi.mock('../stores/fleet', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../stores/fleet')>();
  const real = actual.useFleetStore;
  const live = Object.assign(
    (selector?: (s: ReturnType<typeof real.getState>) => unknown) =>
      selector ? selector(real.getState()) : real.getState(),
    real,
  ) as unknown as typeof real;
  return { ...actual, useFleetStore: live };
});
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
  useFleetStore.setState({ snapshot: null, loading: false, errorCode: null });
  useMachinesStore.setState({ machines: {}, loading: false, errorCode: null });
});

function fleetSession(overrides: Partial<FleetSession> = {}): FleetSession {
  return { id: 's-1', tool: 'claude', live: true, origin: 'paneld', cwd: '/w/proj', ...overrides };
}

function fleetSnapshot(overrides: Partial<FleetSnapshot> = {}): FleetSnapshot {
  return { generatedAt: 1000, adapters: [], sessions: [], ...overrides };
}

function machine(overrides: Partial<MachineStateDto> = {}): MachineStateDto {
  return { id: 'mars', label: 'Mars', state: 'connected', lastSeenAt: 500, ...overrides };
}

function render(): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <ManageHome />
    </MemoryRouter>,
  );
}

describe('ManageHome machine honesty (parity with FleetPanel)', () => {
  it('stale machine: session chip is dimmed, has no live dot, staleSnapshot in title', () => {
    useMachinesStore.setState({ machines: { mars: machine({ state: 'stale', lastSeenAt: 500 }) } });
    useFleetStore.setState({
      snapshot: fleetSnapshot({
        sessions: [fleetSession({ id: 's-mars', title: 'mars-job', live: true, machine: 'mars' })],
      }),
    });
    const html = render();

    expect(html).toContain('opacity:0.55');
    expect(html).toContain(ko.machines.staleSnapshot); // in the chip title
    expect(html).not.toContain('tn-dot--live');
    expect(html).toContain('Mars'); // remote machine label on the chip
  });

  it('connected remote session: live dot present, machine label shown, not dimmed', () => {
    useMachinesStore.setState({ machines: { mars: machine({ state: 'connected' }) } });
    useFleetStore.setState({
      snapshot: fleetSnapshot({
        sessions: [fleetSession({ id: 's-mars', title: 'mars-job', live: true, machine: 'mars' })],
      }),
    });
    const html = render();

    expect(html).toContain('tn-dot--live');
    expect(html).toContain('Mars');
    expect(html).not.toContain('opacity:0.55');
    expect(html).not.toContain(ko.machines.staleSnapshot);
  });
});

describe('ManageHome machine filter', () => {
  it('unfiltered board renders sessions from both local and remote machines', () => {
    useMachinesStore.setState({ machines: { mars: machine({ state: 'connected' }) } });
    useFleetStore.setState({
      snapshot: fleetSnapshot({
        sessions: [
          fleetSession({ id: 's-local', title: 'local-job' }),
          fleetSession({ id: 's-mars', title: 'mars-job', machine: 'mars' }),
        ],
      }),
    });
    const html = render();
    expect(html).toContain('local-job');
    expect(html).toContain('mars-job');
    // The filter strip itself renders (the "전체" clear chip + machine chip).
    expect(html).toContain(ko.machines.filterAll);
  });

  it('the narrowing predicate (sessionMachineId) selects only the chosen machine', () => {
    // Mirrors ManageHome's inline filter: `sessionMachineId(s) === machineFilter`.
    const sessions = [
      fleetSession({ id: 's-local', title: 'local-job' }),
      fleetSession({ id: 's-mars', title: 'mars-job', machine: 'mars' }),
    ];
    expect(sessions.filter((s) => sessionMachineId(s) === 'mars').map((s) => s.id)).toEqual([
      's-mars',
    ]);
    expect(sessions.filter((s) => sessionMachineId(s) === 'local').map((s) => s.id)).toEqual([
      's-local',
    ]);
  });
});
