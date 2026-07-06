/**
 * Approval-inbox tests: agent-origin confirmation events become cards,
 * resolve is optimistic-PENDING only (green requires the server's 200),
 * a 404 resolve is the honest 'gone' state, non-agent confirmations never
 * enter the inbox, and the audit trail records exactly the received
 * agent.action events. All fetches mocked; no real CLIs, no real home.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Envelope } from '@terminull/shared';
import { setFetchImpl } from '../api/client';
import { pendingApprovals, useApprovalsStore } from './approvals';

let restoreFetch: (() => void) | null = null;
let seq = 0;

afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
  seq = 0;
  useApprovalsStore.setState({ entries: [], loading: false, errorCode: null });
});

function ev(type: string, payload: unknown, actor: Envelope['actor'] = 'agent'): Envelope {
  seq += 1;
  return { seq, ts: 1000 + seq, v: 1, type, machine: 'test', actor, payload };
}

const ORIGIN = { kind: 'manage-agent' as const, proposalId: 'p-1', turnId: 't-1' };

function pendingEvent(id = 'c-1'): Envelope {
  return ev('confirmation.pending', {
    confirmationId: id,
    action: 'session.spawn',
    params: { adapterId: 'generic-pty' },
    origin: ORIGIN,
  });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('approvals inbox store', () => {
  it('seeds from GET /api/agent/approvals', async () => {
    restoreFetch = setFetchImpl(() =>
      Promise.resolve(
        json(200, {
          pending: [
            {
              id: 'c-9',
              action: 'session.spawn',
              actor: 'agent',
              params: {},
              createdAt: 111,
              origin: ORIGIN,
            },
          ],
        }),
      ),
    );
    await useApprovalsStore.getState().refresh();
    const entries = useApprovalsStore.getState().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ state: 'pending', card: { id: 'c-9' } });
  });

  it('an agent-origin confirmation.pending event becomes a card; non-agent does not', () => {
    const store = useApprovalsStore.getState();
    store.applyEvents([
      pendingEvent('c-1'),
      // Same event shape WITHOUT an agent origin — stays out of this inbox.
      ev('confirmation.pending', { confirmationId: 'c-2', action: 'directive.send', params: {} }),
    ]);
    const entries = useApprovalsStore.getState().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.card).toMatchObject({
      id: 'c-1',
      action: 'session.spawn',
      origin: { proposalId: 'p-1' },
    });
  });

  it('approve is resolving until the server confirms, then approved', async () => {
    let resolveHttp: ((r: Response) => void) | null = null;
    restoreFetch = setFetchImpl(() => new Promise<Response>((resolve) => (resolveHttp = resolve)));
    const store = useApprovalsStore.getState();
    store.applyEvents([pendingEvent('c-1')]);
    const done = store.resolve('c-1', 'approve');
    // Optimistic state is PENDING-shaped, never a green outcome.
    expect(useApprovalsStore.getState().entries[0]!.state).toBe('resolving');
    resolveHttp!(
      json(200, {
        approved: true,
        confirmationId: 'c-1',
        action: 'session.spawn',
        resultStatus: 201,
        result: {},
      }),
    );
    await done;
    const entry = useApprovalsStore.getState().entries[0]!;
    expect(entry.state).toBe('approved');
    expect(entry.resultStatus).toBe(201);
  });

  it('approving a params-carrying card works and keeps the params intact', async () => {
    restoreFetch = setFetchImpl(() =>
      Promise.resolve(
        json(200, {
          approved: true,
          confirmationId: 'c-1',
          action: 'session.spawn',
          resultStatus: 201,
          result: {},
        }),
      ),
    );
    const store = useApprovalsStore.getState();
    store.applyEvents([
      ev('confirmation.pending', {
        confirmationId: 'c-1',
        action: 'session.spawn',
        params: { cwd: '/tmp/spawn-here', cmd: 'rm -rf build' },
        origin: ORIGIN,
      }),
    ]);
    await store.resolve('c-1', 'approve');
    const entry = useApprovalsStore.getState().entries[0]!;
    expect(entry.state).toBe('approved');
    expect(entry.card.params).toEqual({ cwd: '/tmp/spawn-here', cmd: 'rm -rf build' });
  });

  it('a failed resolve returns the card to pending with the code', async () => {
    restoreFetch = setFetchImpl(() => Promise.resolve(json(403, { code: 'user_required' })));
    const store = useApprovalsStore.getState();
    store.applyEvents([pendingEvent('c-1')]);
    await store.resolve('c-1', 'reject');
    const entry = useApprovalsStore.getState().entries[0]!;
    expect(entry.state).toBe('pending');
    expect(entry.errorCode).toBe('user_required');
    expect(pendingApprovals(useApprovalsStore.getState().entries)).toHaveLength(1);
  });

  it('a 404 resolve is the honest gone state (in-memory queue restarted)', async () => {
    restoreFetch = setFetchImpl(() => Promise.resolve(json(404, { code: 'not_found' })));
    const store = useApprovalsStore.getState();
    store.applyEvents([pendingEvent('c-1')]);
    await store.resolve('c-1', 'approve');
    expect(useApprovalsStore.getState().entries[0]!.state).toBe('gone');
  });

  it('confirmation.approved from the stream resolves the card (another client acted)', () => {
    const store = useApprovalsStore.getState();
    store.applyEvents([pendingEvent('c-1')]);
    store.applyEvents([ev('confirmation.approved', { confirmationId: 'c-1' }, 'user')]);
    expect(useApprovalsStore.getState().entries[0]!.state).toBe('approved');
  });

  it('agent.action events accumulate as the audit trail', () => {
    const store = useApprovalsStore.getState();
    store.applyEvents([pendingEvent('c-1')]);
    store.applyEvents([
      ev('agent.action', {
        phase: 'pending',
        proposalId: 'p-1',
        turnId: 't-1',
        actionKind: 'spawn_session',
        permissionAction: 'session.spawn',
        confirmationId: 'c-1',
      }),
      ev('agent.action', {
        phase: 'approved',
        proposalId: 'p-1',
        turnId: 't-1',
        actionKind: 'spawn_session',
        permissionAction: 'session.spawn',
        confirmationId: 'c-1',
      }),
      ev('agent.action', {
        phase: 'executed',
        proposalId: 'p-1',
        turnId: 't-1',
        actionKind: 'spawn_session',
        permissionAction: 'session.spawn',
        confirmationId: 'c-1',
        resultCode: 'spawned',
      }),
    ]);
    const trail = useApprovalsStore.getState().entries[0]!.trail;
    expect(trail.map((s) => s.phase)).toEqual(['pending', 'approved', 'executed']);
    expect(trail[2]!.resultCode).toBe('spawned');
  });

  it('refresh keeps locally-resolved history while adopting the server pending list', async () => {
    restoreFetch = setFetchImpl(() => Promise.resolve(json(200, { pending: [] })));
    const store = useApprovalsStore.getState();
    store.applyEvents([pendingEvent('c-1')]);
    store.applyEvents([ev('confirmation.rejected', { confirmationId: 'c-1' }, 'user')]);
    await store.refresh();
    const entries = useApprovalsStore.getState().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.state).toBe('rejected');
  });
});
