/**
 * Connection/attention store tests (M9 W7 — GET-seeded confirmations + inline
 * answers). The honesty-critical branches: the REST seed makes pending
 * confirmations visible BEFORE any WS event (a reload no longer loses them),
 * the seed and the stream never duplicate one confirmation, an inline resolve
 * turns final only on the server's 200 (404 = honest gone), and an ask answer
 * keeps the item until the authoritative ask.answered event — only its honest
 * delivery state changes. All fetches mocked; no server, no real sessions.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Envelope } from '@terminull/shared';
import { setFetchImpl } from '../api/client';
import { useConnectionStore } from './connection';

let restoreFetch: (() => void) | null = null;
let seq = 0;

afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
  seq = 0;
  useConnectionStore.setState({ wsStatus: 'offline', seq: 0, hostConnected: null, attention: [] });
});

function ev(type: string, payload: unknown, sessionId?: string): Envelope {
  seq += 1;
  return {
    seq,
    ts: 1000 + seq,
    v: 1,
    type,
    machine: 'test',
    actor: 'system',
    ...(sessionId !== undefined ? { sessionId } : {}),
    payload,
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const PENDING = [
  { id: 'c-1', action: 'harness.write_danger', actor: 'agent', params: {}, createdAt: 500 },
  { id: 'c-2', action: 'session.spawn', actor: 'agent', params: {}, createdAt: 600, sessionId: 's-9' },
];

describe('confirmation GET-seed (oracle h, store half)', () => {
  it('seedConfirmations surfaces pending confirmations before any WS event', () => {
    useConnectionStore.getState().seedConfirmations(PENDING);
    const attention = useConnectionStore.getState().attention;
    expect(attention).toHaveLength(2);
    expect(attention[0]).toMatchObject({
      key: 'confirm:c-1',
      kind: 'confirmation',
      refId: 'c-1',
      summary: 'harness.write_danger',
      ts: 500,
    });
    expect(attention[1]).toMatchObject({ key: 'confirm:c-2', sessionId: 's-9' });
  });

  it('the seed and the stream never duplicate one confirmation (either order)', () => {
    const store = useConnectionStore.getState();
    store.seedConfirmations([PENDING[0]!]);
    store.applyEvents([ev('confirmation.pending', { confirmationId: 'c-1', action: 'x' })]);
    expect(useConnectionStore.getState().attention).toHaveLength(1);
    // Reverse order: stream first, seed second.
    useConnectionStore.getState().applyEvents([
      ev('confirmation.pending', { confirmationId: 'c-3', action: 'y' }),
    ]);
    useConnectionStore
      .getState()
      .seedConfirmations([{ id: 'c-3', action: 'y', actor: 'agent', params: {}, createdAt: 1 }]);
    expect(
      useConnectionStore.getState().attention.filter((a) => a.key === 'confirm:c-3'),
    ).toHaveLength(1);
  });

  it('a confirmation.approved event clears the seeded item', () => {
    useConnectionStore.getState().seedConfirmations(PENDING);
    useConnectionStore.getState().applyEvents([ev('confirmation.approved', { confirmationId: 'c-1' })]);
    expect(useConnectionStore.getState().attention.map((a) => a.key)).toEqual(['confirm:c-2']);
  });
});

describe('inline confirmation resolve', () => {
  it('removes the item on the server 200 — and only then', async () => {
    const calls: string[] = [];
    restoreFetch = setFetchImpl((url) => {
      calls.push(url);
      return Promise.resolve(json(200, { approved: true }));
    });
    useConnectionStore.getState().seedConfirmations(PENDING);
    await useConnectionStore.getState().resolveConfirmation('c-1', 'approve');
    expect(calls).toEqual(['/api/confirmations/c-1/approve']);
    expect(useConnectionStore.getState().attention.map((a) => a.key)).toEqual(['confirm:c-2']);
  });

  it('a 404 resolve is the honest gone state (item removed, no fake error)', async () => {
    restoreFetch = setFetchImpl(() => Promise.resolve(json(404, { code: 'not_found' })));
    useConnectionStore.getState().seedConfirmations([PENDING[0]!]);
    await useConnectionStore.getState().resolveConfirmation('c-1', 'reject');
    expect(useConnectionStore.getState().attention).toHaveLength(0);
  });

  it('a failed resolve keeps the item actionable with the machine code', async () => {
    restoreFetch = setFetchImpl(() => Promise.resolve(json(500, { code: 'internal' })));
    useConnectionStore.getState().seedConfirmations([PENDING[0]!]);
    await useConnectionStore.getState().resolveConfirmation('c-1', 'approve');
    const item = useConnectionStore.getState().attention[0];
    expect(item).toMatchObject({ key: 'confirm:c-1', resolving: false, errorCode: 'internal' });
  });
});

describe('ask options + inline answer', () => {
  it('captures string[] options from the ask payload', () => {
    useConnectionStore.getState().applyEvents([
      ev('session.ask', { askId: 'a-1', summary: '어느 브랜치로 할까요?', options: ['main', 'dev'] }, 's-1'),
    ]);
    const item = useConnectionStore.getState().attention[0];
    expect(item).toMatchObject({ kind: 'ask', refId: 'a-1', options: ['main', 'dev'] });
  });

  it('answerAsk delivers a directive and records the honest delivery state', async () => {
    const bodies: unknown[] = [];
    restoreFetch = setFetchImpl((url, init) => {
      bodies.push([url, JSON.parse(String(init?.body))]);
      return Promise.resolve(json(200, { delivered: true }));
    });
    useConnectionStore
      .getState()
      .applyEvents([ev('session.ask', { askId: 'a-1', options: ['main'] }, 's-1')]);
    await useConnectionStore.getState().answerAsk('ask:a-1', 'main');
    expect(bodies).toEqual([['/api/directive', { sessionId: 's-1', text: 'main' }]]);
    // The item STAYS until ask.answered — only its delivery state changes.
    const item = useConnectionStore.getState().attention[0];
    expect(item).toMatchObject({ key: 'ask:a-1', answerState: 'delivered' });
    // The authoritative event clears it.
    useConnectionStore.getState().applyEvents([ev('ask.answered', { askId: 'a-1' })]);
    expect(useConnectionStore.getState().attention).toHaveLength(0);
  });

  it('a parked directive (202 pending confirmation) is reported as such', async () => {
    restoreFetch = setFetchImpl(() =>
      Promise.resolve(json(202, { code: 'pending_confirmation', confirmationId: 'c-77' })),
    );
    useConnectionStore.getState().applyEvents([ev('session.ask', { askId: 'a-2' }, 's-1')]);
    await useConnectionStore.getState().answerAsk('ask:a-2', 'yes');
    expect(useConnectionStore.getState().attention[0]).toMatchObject({
      answerState: 'pendingConfirmation',
    });
  });
});
