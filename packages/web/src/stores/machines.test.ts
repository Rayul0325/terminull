/**
 * Machine store tests — the pure FSM reduce (boot/connect/stale/recovery/
 * disable), payload validation, WS ingest of machine.state envelopes, fleet
 * seeding, REST refresh, and the honest lastSeen unit split. All fetches
 * mocked; no server, no real machines, no real home directories.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Envelope, MachineStateDto, MachineStatePayload } from '@terminull/shared';
import { setFetchImpl } from '../api/client';
import {
  asMachineStatePayload,
  lastSeenParts,
  machinesList,
  reduceMachineState,
  useMachinesStore,
} from './machines';

let restoreFetch: (() => void) | null = null;
let seq = 0;

afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
  seq = 0;
  useMachinesStore.setState({ machines: {}, loading: false, errorCode: null });
});

function transition(overrides: Partial<MachineStatePayload> = {}): MachineStatePayload {
  return {
    machineId: 'mars',
    previous: 'connecting',
    state: 'connected',
    lastSeenAt: 1000,
    code: 'dial_ok',
    ...overrides,
  };
}

function ev(payload: unknown): Envelope {
  seq += 1;
  return {
    seq,
    ts: 1000 + seq,
    v: 1,
    type: 'machine.state',
    machine: 'test',
    actor: 'system',
    payload,
  };
}

function dto(overrides: Partial<MachineStateDto> = {}): MachineStateDto {
  return { id: 'mars', label: 'Mars', state: 'connected', lastSeenAt: 500, ...overrides };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('reduceMachineState (FSM transitions)', () => {
  it('boot on an unknown machine creates an honest connecting entry (label=id)', () => {
    const next = reduceMachineState(
      undefined,
      transition({ previous: 'connecting', state: 'connecting', lastSeenAt: null, code: 'boot' }),
    );
    expect(next).toMatchObject({
      id: 'mars',
      label: 'mars',
      state: 'connecting',
      lastSeenAt: null,
    });
    expect(next.lastError).toBeUndefined();
  });

  it('dial_ok connects and clears the failure streak', () => {
    const prev = dto({
      state: 'connecting',
      lastSeenAt: null,
      attempts: 3,
      lastError: 'dial_failed',
    });
    const next = reduceMachineState(prev, transition({ lastSeenAt: 2000, code: 'dial_ok' }));
    expect(next.state).toBe('connected');
    expect(next.lastSeenAt).toBe(2000);
    expect(next.lastError).toBeUndefined();
    expect(next.attempts).toBeUndefined();
    expect(next.label).toBe('Mars'); // config label survives transitions
  });

  it('relay_exit goes stale and KEEPS lastSeenAt (last verified contact)', () => {
    const next = reduceMachineState(
      dto(),
      transition({ previous: 'connected', state: 'stale', lastSeenAt: 500, code: 'relay_exit' }),
    );
    expect(next.state).toBe('stale');
    expect(next.lastSeenAt).toBe(500);
    expect(next.lastError).toBe('relay_exit');
  });

  it('heartbeat_timeout is also a stale-with-lastSeen failure', () => {
    const next = reduceMachineState(
      dto(),
      transition({
        previous: 'connected',
        state: 'stale',
        lastSeenAt: 800,
        code: 'heartbeat_timeout',
      }),
    );
    expect(next).toMatchObject({ state: 'stale', lastSeenAt: 800, lastError: 'heartbeat_timeout' });
  });

  it('recovery: stale -> connected clears lastError and refreshes lastSeenAt', () => {
    const stale = dto({ state: 'stale', lastSeenAt: 500, lastError: 'relay_exit' });
    const next = reduceMachineState(
      stale,
      transition({ previous: 'stale', state: 'connected', lastSeenAt: 9000, code: 'dial_ok' }),
    );
    expect(next.state).toBe('connected');
    expect(next.lastSeenAt).toBe(9000);
    expect(next.lastError).toBeUndefined();
  });

  it('disable/enable transitions apply verbatim', () => {
    const disabled = reduceMachineState(
      dto(),
      transition({ previous: 'connected', state: 'disabled', lastSeenAt: 500, code: 'disabled' }),
    );
    expect(disabled.state).toBe('disabled');
    const reenabled = reduceMachineState(
      disabled,
      transition({ previous: 'disabled', state: 'connecting', lastSeenAt: 500, code: 'enabled' }),
    );
    expect(reenabled.state).toBe('connecting');
  });
});

describe('asMachineStatePayload', () => {
  it('accepts a valid payload including lastSeenAt null', () => {
    expect(asMachineStatePayload(transition({ lastSeenAt: null }))).toMatchObject({
      machineId: 'mars',
      lastSeenAt: null,
    });
  });

  it('rejects malformed payloads', () => {
    expect(asMachineStatePayload(null)).toBeNull();
    expect(asMachineStatePayload('mars')).toBeNull();
    expect(asMachineStatePayload({})).toBeNull();
    expect(asMachineStatePayload(transition({ machineId: '' }))).toBeNull();
    expect(asMachineStatePayload({ ...transition(), state: 'online' })).toBeNull();
    expect(asMachineStatePayload({ ...transition(), lastSeenAt: 'yesterday' })).toBeNull();
  });
});

describe('machines store ingest + seeding', () => {
  it('applies machine.state envelopes and ignores everything else', () => {
    const store = useMachinesStore.getState();
    store.applyEvents([
      ev(
        transition({ previous: 'connecting', state: 'connecting', lastSeenAt: null, code: 'boot' }),
      ),
      { ...ev(null), type: 'session.start' }, // other event types never touch this store
      ev(transition({ lastSeenAt: 3000 })),
      ev('garbage'), // malformed payload dropped, not crashed on
    ]);
    const mars = useMachinesStore.getState().machines['mars'];
    expect(mars).toMatchObject({ id: 'mars', state: 'connected', lastSeenAt: 3000 });
    expect(Object.keys(useMachinesStore.getState().machines)).toEqual(['mars']);
  });

  it('stale then recovery: label from the seed survives the round trip', () => {
    useMachinesStore.getState().seedFromFleet([dto(), dto({ id: 'local', label: 'local' })]);
    useMachinesStore
      .getState()
      .applyEvents([
        ev(
          transition({
            previous: 'connected',
            state: 'stale',
            lastSeenAt: 500,
            code: 'relay_exit',
          }),
        ),
      ]);
    expect(useMachinesStore.getState().machines['mars']).toMatchObject({
      label: 'Mars',
      state: 'stale',
      lastSeenAt: 500,
    });
    useMachinesStore
      .getState()
      .applyEvents([
        ev(
          transition({ previous: 'stale', state: 'connected', lastSeenAt: 9000, code: 'dial_ok' }),
        ),
      ]);
    expect(useMachinesStore.getState().machines['mars']).toMatchObject({
      label: 'Mars',
      state: 'connected',
      lastSeenAt: 9000,
    });
  });

  it('seedFromFleet replaces entries; undefined (pre-M8 server) keeps state', () => {
    useMachinesStore.getState().seedFromFleet([dto({ id: 'venus', label: 'Venus' })]);
    expect(Object.keys(useMachinesStore.getState().machines)).toEqual(['venus']);
    useMachinesStore.getState().seedFromFleet(undefined);
    expect(Object.keys(useMachinesStore.getState().machines)).toEqual(['venus']);
    useMachinesStore.getState().seedFromFleet([dto()]);
    expect(Object.keys(useMachinesStore.getState().machines)).toEqual(['mars']);
  });

  it('refresh populates from GET /api/machines', async () => {
    restoreFetch = setFetchImpl((input) => {
      expect(input).toBe('/api/machines');
      return Promise.resolve(
        json(200, { machines: [dto(), dto({ id: 'local', label: 'local' })] }),
      );
    });
    await useMachinesStore.getState().refresh();
    const state = useMachinesStore.getState();
    expect(state.errorCode).toBeNull();
    expect(Object.keys(state.machines).sort()).toEqual(['local', 'mars']);
  });

  it('a failed refresh surfaces the machine code, keeping prior entries', async () => {
    useMachinesStore.getState().seedFromFleet([dto()]);
    restoreFetch = setFetchImpl(() => Promise.resolve(json(503, { code: 'machine_unavailable' })));
    await useMachinesStore.getState().refresh();
    const state = useMachinesStore.getState();
    expect(state.errorCode).toBe('machine_unavailable');
    expect(state.machines['mars']).toBeDefined();
  });
});

describe('render helpers', () => {
  it('machinesList puts local first, then id order', () => {
    const list = machinesList({
      zeta: dto({ id: 'zeta' }),
      local: dto({ id: 'local' }),
      alpha: dto({ id: 'alpha' }),
    });
    expect(list.map((m) => m.id)).toEqual(['local', 'alpha', 'zeta']);
  });

  it('lastSeenParts picks the largest sensible unit and never goes negative', () => {
    const now = 1_000_000_000;
    expect(lastSeenParts(now - 5_000, now)).toEqual({ unit: 'seconds', count: 5 });
    expect(lastSeenParts(now - 3 * 60_000, now)).toEqual({ unit: 'minutes', count: 3 });
    expect(lastSeenParts(now - 2 * 3_600_000, now)).toEqual({ unit: 'hours', count: 2 });
    expect(lastSeenParts(now - 5 * 86_400_000, now)).toEqual({ unit: 'days', count: 5 });
    expect(lastSeenParts(now + 10_000, now)).toEqual({ unit: 'seconds', count: 0 });
  });
});
