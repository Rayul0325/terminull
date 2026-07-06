/**
 * ManageHome fleet-tree tests. Two concerns:
 *
 * 1. Machine honesty (contract §7, D1) — parity with FleetPanel, now via the
 *    shared SessionRow (P1-B): a session on a STALE machine renders as a
 *    last-known snapshot (dimmed, an `offline` dot never a `running` one, a
 *    staleSnapshot chip); a connected/remote session shows a `running` dot and
 *    its machine label; the machine filter narrows the board.
 * 2. The pill-wall → project-tree + top-of-page health line (P1-B): a HUMAN
 *    title inside a cwd-named group, the offline/ok health verdict per store
 *    state, and a 100-session snapshot rendering without throwing.
 *
 * No DOM test environment here, so the route renders to static markup
 * (react-dom/server) inside a MemoryRouter (it uses <Link>/useNavigate). The
 * stores the route + FleetHealthLine read are re-pointed at their live
 * getState() (renderToStaticMarkup otherwise reads zustand's server snapshot and
 * ignores setState); the heavy sibling sections render for real against their
 * empty defaults, as before.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import i18n from '../i18n';
import ko from '../i18n/locales/ko.json';
import type { FleetSession, FleetSnapshot, MachineStateDto } from '../api/types';
import { sessionMachineId, useFleetStore } from '../stores/fleet';
import { useMachinesStore } from '../stores/machines';
import { useConnectionStore } from '../stores/connection';
import { useApprovalsStore } from '../stores/approvals';
import { ManageHome } from './ManageHome';

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
vi.mock('../stores/approvals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../stores/approvals')>();
  const real = actual.useApprovalsStore;
  const live = Object.assign(
    (selector?: (s: ReturnType<typeof real.getState>) => unknown) =>
      selector ? selector(real.getState()) : real.getState(),
    real,
  ) as unknown as typeof real;
  return { ...actual, useApprovalsStore: live };
});

beforeAll(async () => {
  if (!i18n.isInitialized) {
    await new Promise<void>((resolve) => i18n.on('initialized', () => resolve()));
  }
});

afterEach(() => {
  useFleetStore.setState({ snapshot: null, loading: false, errorCode: null });
  useMachinesStore.setState({ machines: {}, loading: false, errorCode: null });
  useConnectionStore.setState({ wsStatus: 'offline', seq: 0, hostConnected: null, attention: [] });
  useApprovalsStore.setState({ entries: [], loading: false, errorCode: null });
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
  it('stale machine: row is dimmed, offline dot (not running), staleSnapshot chip', () => {
    useMachinesStore.setState({ machines: { mars: machine({ state: 'stale', lastSeenAt: 500 }) } });
    useFleetStore.setState({
      snapshot: fleetSnapshot({
        sessions: [fleetSession({ id: 's-mars', title: 'mars-job', live: true, machine: 'mars' })],
      }),
    });
    const html = render();

    expect(html).toContain('opacity:0.55');
    expect(html).toContain(ko.machines.staleSnapshot);
    expect(html).toContain('mars-job'); // human title, not a bare uuid
    expect(html).toContain('tn-status-dot--offline');
    expect(html).not.toContain('tn-status-dot--running');
    expect(html).toContain('Mars'); // remote machine label (single-machine group header)
  });

  it('connected remote session: running dot present, machine label shown, not dimmed', () => {
    useMachinesStore.setState({ machines: { mars: machine({ state: 'connected' }) } });
    useFleetStore.setState({
      snapshot: fleetSnapshot({
        sessions: [fleetSession({ id: 's-mars', title: 'mars-job', live: true, machine: 'mars' })],
      }),
    });
    const html = render();

    expect(html).toContain('tn-status-dot--running');
    expect(html).toContain('Mars');
    expect(html).not.toContain('opacity:0.55');
    expect(html).not.toContain(ko.machines.staleSnapshot);
  });
});

describe('ManageHome machine filter', () => {
  it('unfiltered board renders sessions from both local and remote machines', () => {
    useConnectionStore.setState({ wsStatus: 'online' });
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

describe('ManageHome fleet tree + health line', () => {
  it('renders a human session title inside its cwd-named project group', () => {
    useConnectionStore.setState({ wsStatus: 'online' });
    useFleetStore.setState({
      snapshot: fleetSnapshot({
        sessions: [
          fleetSession({
            id: 'uuid-aaaa-bbbb-cccc',
            title: '리팩터 작업',
            cwd: '/Users/x/proj-a',
          }),
        ],
      }),
    });
    const html = render();
    expect(html).toContain('리팩터 작업');
    expect(html).toContain('proj-a'); // group name = cwd basename
    expect(html).toContain(ko.fleet.health.ok); // healthy verdict at the top
  });

  it('shows the offline health verdict when the websocket is down', () => {
    useConnectionStore.setState({ wsStatus: 'offline' });
    useFleetStore.setState({ snapshot: fleetSnapshot({ sessions: [] }) });
    expect(render()).toContain(ko.fleet.health.offline);
  });

  it('renders a 100-session snapshot without throwing', () => {
    useConnectionStore.setState({ wsStatus: 'online' });
    const sessions = Array.from({ length: 100 }, (_, i) =>
      fleetSession({
        id: `s-${i}`,
        title: `job ${i}`,
        cwd: `/Users/x/proj-${i % 5}`,
        live: i % 2 === 0,
      }),
    );
    useFleetStore.setState({ snapshot: fleetSnapshot({ sessions }) });
    expect(() => render()).not.toThrow();
    const html = render();
    expect(html).toContain('job 0');
    expect(html).toContain('job 99');
  });
});
