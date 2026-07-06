/**
 * MachineManager unit tests (M8 contract §8 B2/B3): the FSM against a REAL
 * StdioProcessTransport spawning a scripted fake agent (a local node child —
 * never ssh, never a real remote). Registry machine-awareness is covered at
 * the bottom. Every path lives under os.tmpdir(); nothing touches real state.
 */
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { MachineConfig, MachineStatePayload, SpawnSpec } from '@terminull/shared';
import {
  MachineManager,
  MachineUnavailableError,
  UnknownMachineError,
  type MachineManagerOptions,
} from '../src/machines';
import { SessionRegistry } from '../src/sessions';
import { waitFor } from './harness';

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fake-agent.mjs',
);

function fakeMachine(
  id: string,
  extra: string[] = [],
  overrides: Partial<MachineConfig> = {},
): MachineConfig {
  return {
    id,
    label: id,
    transport: { kind: 'stdio', cmd: process.execPath, args: [FIXTURE, ...extra] },
    enabled: true,
    ...overrides,
  };
}

const SPEC: SpawnSpec = {
  cmd: 'sh',
  args: [],
  cwd: os.tmpdir(),
  env: {},
  cols: 80,
  rows: 24,
};

interface Ctx {
  manager: MachineManager;
  events: MachineStatePayload[];
  ups: { machineId: string; resumed: boolean; bootId: string }[];
}

const managers: MachineManager[] = [];

function startManager(
  machines: MachineConfig[],
  timings: Partial<
    Pick<
      MachineManagerOptions,
      'heartbeatMs' | 'requestTimeoutMs' | 'backoffMinMs' | 'backoffMaxMs'
    >
  > = {},
): Ctx {
  const events: MachineStatePayload[] = [];
  const ups: Ctx['ups'] = [];
  const manager = new MachineManager({
    machines,
    heartbeatMs: 100,
    requestTimeoutMs: 2000,
    backoffMinMs: 25,
    backoffMaxMs: 100,
    collectTimeoutMs: 2000,
    onState: (p) => events.push(p),
    onUp: (machineId, info) => ups.push({ machineId, resumed: info.resumed, bootId: info.bootId }),
    ...timings,
  });
  managers.push(manager);
  manager.start();
  return { manager, events, ups };
}

afterEach(() => {
  for (const m of managers.splice(0)) m.stop();
});

describe('MachineManager FSM', () => {
  it('dials through shell noise, connects, and emits boot → dial_ok', async () => {
    const { manager, events, ups } = startManager([fakeMachine('m1', ['--noise'])]);
    await waitFor(() => manager.get('m1')?.state === 'connected', 10_000);
    const dto = manager.get('m1')!;
    expect(dto.hostId).toBe('fake-host');
    expect(dto.bootId).toBeTruthy();
    expect(dto.lastSeenAt).toBeTypeOf('number');
    expect(events.map((e) => e.code)).toEqual(['boot', 'dial_ok']);
    expect(events[0]).toMatchObject({ machineId: 'm1', state: 'connecting' });
    expect(events[1]).toMatchObject({
      machineId: 'm1',
      state: 'connected',
      previous: 'connecting',
    });
    expect(manager.controlPid('m1')).toBeGreaterThan(0);
    expect(ups).toEqual([{ machineId: 'm1', resumed: false, bootId: dto.bootId }]);
  }, 15_000);

  it('relay death ⇒ stale{lastSeenAt, relay_exit}; auto-redial ⇒ connected resumed', async () => {
    const { manager, events, ups } = startManager([fakeMachine('m1', ['--boot-id=stable'])]);
    await waitFor(() => manager.get('m1')?.state === 'connected', 10_000);
    const pid = manager.controlPid('m1')!;
    process.kill(pid, 'SIGKILL');
    await waitFor(() => manager.get('m1')?.state === 'stale', 10_000);
    const stale = events.find((e) => e.state === 'stale')!;
    expect(stale.code).toBe('relay_exit');
    expect(stale.lastSeenAt).toBeTypeOf('number');
    // Redial with backoff respawns a FRESH relay child to the same "daemon".
    await waitFor(() => manager.get('m1')?.state === 'connected', 10_000);
    expect(manager.controlPid('m1')).not.toBe(pid);
    expect(ups.map((u) => u.resumed)).toEqual([false, true]);
    // Full honest event order, no silent hops.
    expect(events.map((e) => `${e.state}:${e.code}`)).toEqual([
      'connecting:boot',
      'connected:dial_ok',
      'stale:relay_exit',
      'connected:dial_ok',
    ]);
  }, 15_000);

  it('missed heartbeat ⇒ stale{heartbeat_timeout}', async () => {
    const { manager, events } = startManager([fakeMachine('m1', ['--ignore-list'])], {
      heartbeatMs: 60,
      requestTimeoutMs: 120,
    });
    await waitFor(() => manager.get('m1')?.state === 'connected', 10_000);
    await waitFor(() => events.some((e) => e.state === 'stale'), 10_000);
    expect(events.find((e) => e.state === 'stale')!.code).toBe('heartbeat_timeout');
  }, 15_000);

  it('a never-reached machine stays connecting with attempts, never fake-connected', async () => {
    const { manager, events } = startManager([fakeMachine('m1', ['--die'])]);
    await waitFor(() => (manager.get('m1')?.attempts ?? 0) >= 2, 10_000);
    const dto = manager.get('m1')!;
    expect(dto.state).toBe('connecting');
    expect(dto.lastSeenAt).toBeNull(); // no verified contact — nothing to claim
    expect(dto.lastError).toBeTruthy();
    expect(events.every((e) => e.state !== 'connected')).toBe(true);
    expect(events.filter((e) => e.code === 'dial_failed').length).toBeGreaterThanOrEqual(2);
  }, 15_000);

  it('disabled machines are never dialed and refuse operations honestly', async () => {
    const { manager, events } = startManager([fakeMachine('m1', [], { enabled: false })]);
    expect(manager.get('m1')!.state).toBe('disabled');
    await new Promise((r) => setTimeout(r, 150));
    expect(events).toEqual([]);
    expect(manager.controlPid('m1')).toBeNull();
    await expect(manager.spawn('m1', SPEC)).rejects.toBeInstanceOf(MachineUnavailableError);
  });

  it('reload applies enable/disable/remove/add as honest FSM transitions', async () => {
    const { manager, events } = startManager([fakeMachine('m1')]);
    await waitFor(() => manager.get('m1')?.state === 'connected', 10_000);

    manager.reload([fakeMachine('m1', [], { enabled: false })]);
    expect(manager.get('m1')!.state).toBe('disabled');
    expect(events.at(-1)).toMatchObject({ machineId: 'm1', state: 'disabled', code: 'disabled' });
    expect(manager.controlPid('m1')).toBeNull();

    manager.reload([fakeMachine('m1')]);
    expect(events.at(-1)).toMatchObject({ machineId: 'm1', state: 'connecting', code: 'enabled' });
    await waitFor(() => manager.get('m1')?.state === 'connected', 10_000);

    manager.reload([fakeMachine('m2')]);
    expect(manager.has('m1')).toBe(false);
    expect(manager.has('m2')).toBe(true);
    expect(events.some((e) => e.machineId === 'm1' && e.state === 'disabled')).toBe(true);
    expect(events.some((e) => e.machineId === 'm2' && e.code === 'boot')).toBe(true);
    await waitFor(() => manager.get('m2')?.state === 'connected', 10_000);
  }, 20_000);

  it('spawn/collect flow on the control link; unknown machines are coded errors', async () => {
    const { manager } = startManager([
      fakeMachine('m1'),
      fakeMachine('m2', ['--collect-sessions']),
    ]);
    await waitFor(
      () => manager.get('m1')?.state === 'connected' && manager.get('m2')?.state === 'connected',
      10_000,
    );
    const spawned = await manager.spawn('m1', SPEC);
    expect(spawned.sid).toBeGreaterThanOrEqual(100);
    expect(spawned.pid).toBe(9999);
    expect((await manager.list('m1')).some((s) => s.sid === spawned.sid)).toBe(true);

    // Honest unsupported collect passthrough (relay without collectors).
    const c1 = await manager.collect('m1');
    expect(c1.supported).toBe(false);
    expect(c1.reason).toBe('collectors_unavailable');
    expect(c1.sessions).toEqual([]);
    // Machine still connected — a collect result NEVER decides liveness.
    expect(manager.get('m1')!.state).toBe('connected');

    const c2 = await manager.collect('m2');
    expect(c2.supported).toBe(true);
    expect(c2.sessions[0]?.id).toBe('remote-claude-1');

    await expect(manager.spawn('zeta', SPEC)).rejects.toBeInstanceOf(UnknownMachineError);
    expect(() => manager.kill('zeta', 1)).toThrow(UnknownMachineError);
  }, 15_000);

  it('attachment: byte round-trip on its own stream; closed when the machine goes stale', async () => {
    const { manager } = startManager([fakeMachine('m1', ['--session=7', '--boot-id=stable'])]);
    await waitFor(() => manager.get('m1')?.state === 'connected', 10_000);
    const att = await manager.openAttachment('m1', 7, {});
    const out: Buffer[] = [];
    let closed = false;
    att.onOut((d) => out.push(d));
    att.onClose(() => {
      closed = true;
    });
    att.write(Buffer.from('ping-bytes'));
    await waitFor(() => Buffer.concat(out).toString('utf8').includes('ping-bytes'), 10_000);

    // Control-link death must close open viewer attachments (honest 1011 path).
    process.kill(manager.controlPid('m1')!, 'SIGKILL');
    await waitFor(() => closed, 10_000);
    expect(closed).toBe(true);
  }, 15_000);

  it('refuses reserved/duplicate ids at construction and reload (atomically)', async () => {
    expect(
      () =>
        new MachineManager({
          machines: [fakeMachine('local')],
          onState: () => {},
        }),
    ).toThrow(/reserved or duplicated/);
    expect(
      () =>
        new MachineManager({
          machines: [fakeMachine('m1'), fakeMachine('m1')],
          onState: () => {},
        }),
    ).toThrow(/reserved or duplicated/);

    const { manager } = startManager([fakeMachine('m1')]);
    await waitFor(() => manager.get('m1')?.state === 'connected', 10_000);
    expect(() => manager.reload([fakeMachine('m1'), fakeMachine('m1')])).toThrow(
      /reserved or duplicated/,
    );
    // Atomic refusal: the existing runtime was left untouched.
    expect(manager.get('m1')!.state).toBe('connected');
  }, 15_000);
});

describe('SessionRegistry machine-awareness', () => {
  const base = { adapterId: 'x', cwd: '/', running: true, createdAt: 1 };

  it('resolves sid collisions across machines and reconciles per machine only', () => {
    const reg = new SessionRegistry();
    reg.add({ id: 'a', sid: 5, label: 'a', ...base }); // machine defaults to 'local'
    reg.add({ id: 'b', sid: 5, label: 'b', ...base, machine: 'mars' });

    expect(reg.get('a')?.machine).toBe('local');
    expect(reg.getBySid(5)?.id).toBe('a');
    expect(reg.getBySid(5, 'mars')?.id).toBe('b');

    // mars daemon rebooted empty: ONLY the mars session dies.
    const ended = reg.reconcile([], false, 'mars');
    expect(ended.map((s) => s.id)).toEqual(['b']);
    expect(reg.get('a')?.running).toBe(true);
    expect(reg.get('b')?.running).toBe(false);
  });

  it('re-adopts advertised sessions onto the right machine', () => {
    const reg = new SessionRegistry();
    const summary = {
      sid: 9,
      cmd: 'sh',
      args: [],
      cols: 80,
      rows: 24,
      owned: true,
      running: true,
      headSeq: 0,
      meta: { terminullId: 'srv-1', adapterId: 'generic-pty', label: 'L', cwd: '/w' },
    };
    reg.reconcile([summary], false, 'mars');
    const adopted = reg.get('srv-1');
    expect(adopted?.machine).toBe('mars');
    expect(adopted?.running).toBe(true);
    expect(reg.getBySid(9, 'mars')?.id).toBe('srv-1');
    expect(reg.getBySid(9)).toBeUndefined();
  });
});
