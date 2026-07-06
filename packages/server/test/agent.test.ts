/**
 * /api/agent/* + PanelActions executor tests that do NOT depend on a brain
 * turn: permission-settings read/write discipline (user-only, atomic,
 * floor-honest), the approvals inbox filter, disabled-agent honesty, and the
 * §4 audit chain for autonomous/forbidden/denied/failed proposals.
 *
 * Everything runs against tmpdir fixture homes; no real agent CLI is spawned
 * (the one PTY test uses `sh` through the allowlisted generic adapter).
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProposedAction } from '@terminull/shared';
import { api, startStack, waitFor, type Stack } from './harness';
import { FakeBrain } from './fake-brain';

let stack: Stack;

afterEach(async () => {
  await stack.close();
});

const meta = (n: number) => ({ proposalId: `p-${n}`, turnId: 't-1', reason: 'test reason' });

/** agent.action payloads for one proposal, in append order. */
function phasesOf(s: Stack, proposalId: string): string[] {
  return s.server.store.inbox
    .filter((e) => e.type === 'agent.action' && (e.payload as any)?.proposalId === proposalId)
    .map((e) => (e.payload as any).phase);
}

describe('agent status + chat gating', () => {
  it('disabled agent → honest status and 409 on chat', async () => {
    stack = await startStack({ agentEnabled: false });
    const status = await api(stack, 'GET', '/api/agent/status');
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ state: 'disabled', enabled: false });
    expect(status.body.brain.availability).toBe('unverified');
    expect(status.body.budget).toEqual({ spentUsd: null, capUsd: null });

    const chat = await api(stack, 'POST', '/api/agent/chat', {
      body: { text: 'hello' },
      user: true,
    });
    expect(chat.status).toBe(409);
    expect(chat.body.code).toBe('agent_disabled');
  });

  it('chat is user-only; enabled status reports the honest unverified brain', async () => {
    stack = await startStack({ agentBrain: new FakeBrain([]) });
    const status = await api(stack, 'GET', '/api/agent/status');
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ state: 'idle', enabled: true });
    // No probe has run yet → 'unverified', never presented as green.
    expect(status.body.brain).toMatchObject({ id: 'fake', availability: 'unverified' });

    for (const actor of ['agent', 'hook']) {
      const res = await api(stack, 'POST', '/api/agent/chat', {
        body: { text: 'do things' },
        actor,
      });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('user_required');
    }
    // A bare loopback request has no positive user signal either.
    const anonymous = await api(stack, 'POST', '/api/agent/chat', { body: { text: 'hi' } });
    expect(anonymous.status).toBe(403);
  });

  it('status mirrors the confirmation queue: one card reads 1; resolving it OUTSIDE a turn reads 0 + idle', async () => {
    const brain = new FakeBrain([
      [
        {
          kind: 'action',
          action: { kind: 'interrupt_session', sessionId: 'ghost' },
          reason: 'stuck session',
        },
        { kind: 'done', stopReason: 'end_turn' },
      ],
      [{ kind: 'done', stopReason: 'end_turn' }],
    ]);
    stack = await startStack({ agentBrain: brain });

    const chat = await api(stack, 'POST', '/api/agent/chat', {
      body: { text: 'unstick that session' },
      user: true,
    });
    expect(chat.status).toBe(202);
    await waitFor(() =>
      stack.server.store.inbox.some(
        (e) => e.type === 'agent.state' && (e.payload as any)?.state === 'awaiting_approval',
      ),
    );

    // Exactly one card is parked → status reports exactly one (regression:
    // the stored supervisor counter used to double-count the fresh card).
    const inbox = await api(stack, 'GET', '/api/agent/approvals');
    expect(inbox.body.pending).toHaveLength(1);
    const before = await api(stack, 'GET', '/api/agent/status');
    expect(before.body).toMatchObject({ state: 'awaiting_approval', pendingApprovals: 1 });

    // The user resolves the card via REST — NO further chat turn runs.
    const resolved = await api(
      stack,
      'POST',
      `/api/agent/approvals/${inbox.body.pending[0].id}/resolve`,
      { body: { decision: 'approve' }, user: true },
    );
    expect(resolved.status).toBe(200);

    // The drained queue is reflected immediately: count 0, stale
    // awaiting_approval cleared to idle without waiting for the next turn.
    const after = await api(stack, 'GET', '/api/agent/status');
    expect(after.body.pendingApprovals).toBe(0);
    expect(after.body.state).toBe('idle');
  }, 15000);
});

describe('permission settings routes', () => {
  it('GET composes the full catalogue with resolved classes', async () => {
    stack = await startStack({ permissions: { 'directive.send': 'confirm' } });
    const res = await api(stack, 'GET', '/api/agent/permission-settings');
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(1);
    const byId = new Map(res.body.actions.map((a: any) => [a.id, a]));
    expect(byId.size).toBe(11);
    expect(byId.get('directive.send')).toMatchObject({
      class: 'confirm',
      defaultClass: 'autonomous',
      labelKey: 'perm.directive_send',
      requiresTwoStep: false,
    });
    expect(byId.get('session.delete')).toMatchObject({
      floor: 'confirm',
      requiresTwoStep: true,
    });
  });

  it('PUT is refused for the agent actor and leaves the file untouched (oracle negative c)', async () => {
    stack = await startStack({ permissions: { 'session.spawn': 'confirm' } });
    const file = path.join(stack.stateDir, 'permissions.json');
    const before = fs.readFileSync(file, 'utf8');

    const res = await api(stack, 'PUT', '/api/agent/permission-settings', {
      body: { changes: { 'ask.answer': 'autonomous' } },
      actor: 'agent',
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('user_required');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    // And the live settings did not budge either.
    const settings = await api(stack, 'GET', '/api/agent/permission-settings');
    expect(settings.body.actions.find((a: any) => a.id === 'ask.answer').class).toBe('forbidden');
  });

  it('PUT validates atomically: one unknown id rejects the whole batch', async () => {
    stack = await startStack();
    const res = await api(stack, 'PUT', '/api/agent/permission-settings', {
      body: { changes: { 'directive.send': 'forbidden', 'nope.nope': 'confirm' } },
      user: true,
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'unknown_action', actionId: 'nope.nope' });
    // The valid half of the batch must NOT have been applied.
    const settings = await api(stack, 'GET', '/api/agent/permission-settings');
    expect(settings.body.actions.find((a: any) => a.id === 'directive.send').class).toBe(
      'autonomous',
    );

    const bad = await api(stack, 'PUT', '/api/agent/permission-settings', {
      body: { changes: { 'directive.send': 'sometimes' } },
      user: true,
    });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('invalid_class');
  });

  it('PUT applies, persists, audits — and floors stay immutable', async () => {
    stack = await startStack();
    const res = await api(stack, 'PUT', '/api/agent/permission-settings', {
      body: { changes: { 'directive.send': 'forbidden', 'session.delete': 'autonomous' } },
      user: true,
    });
    expect(res.status).toBe(200);
    const byId = new Map(res.body.actions.map((a: any) => [a.id, a]));
    expect((byId.get('directive.send') as any).class).toBe('forbidden');
    // session.delete is floored at confirm for agents — widening is refused
    // by resolution, and the response shows the ENFORCED class.
    expect((byId.get('session.delete') as any).class).toBe('confirm');

    const saved = JSON.parse(
      fs.readFileSync(path.join(stack.stateDir, 'permissions.json'), 'utf8'),
    );
    expect(saved.actions['directive.send']).toBe('forbidden');

    const changed = stack.server.store.inbox.filter(
      (e) => e.type === 'permission.settings_changed',
    );
    expect(changed.length).toBe(2);
    expect(changed[0]!.payload).toMatchObject({
      actionId: 'directive.send',
      previous: 'autonomous',
      next: 'forbidden',
    });
  });
});

describe('PanelActions executor audit chain', () => {
  it('autonomous action executes: proposed → permission.checked(yes) → executed', async () => {
    stack = await startStack();
    const action: ProposedAction = { kind: 'create_board_card', title: 'triage the red build' };
    const outcome = await stack.server.agentActions.execute(action, meta(1));
    expect(outcome).toMatchObject({ status: 'executed' });
    expect((outcome as any).result.created).toBe(true);
    expect(phasesOf(stack, 'p-1')).toEqual(['proposed', 'executed']);

    const checked = stack.server.store.inbox.find((e) => e.type === 'permission.checked');
    expect(checked!.payload).toMatchObject({
      action: 'board.edit',
      decision: 'yes',
      requestActor: 'agent',
    });
    const card = stack.server.store.inbox.find((e) => e.type === 'board.card_created');
    expect((card!.payload as any).title).toBe('triage the red build');
    expect(card!.actor).toBe('agent');
  });

  it('forbidden action is refused + audited: proposed → checked(no) → denied', async () => {
    stack = await startStack();
    const action: ProposedAction = { kind: 'answer_ask', sessionId: 's1', askId: 'a1', choice: 0 };
    const outcome = await stack.server.agentActions.execute(action, meta(2));
    expect(outcome).toEqual({ status: 'denied', code: 'forbidden' });
    expect(phasesOf(stack, 'p-2')).toEqual(['proposed', 'denied']);
    expect(stack.server.store.inbox.filter((e) => e.type === 'permission.checked').length).toBe(1);
  });

  it('an unparseable action is denied WITHOUT reaching the permission gate', async () => {
    stack = await startStack();
    const outcome = await stack.server.agentActions.execute(
      { kind: 'set_permission_settings', changes: { 'ask.answer': 'autonomous' } } as any,
      meta(3),
    );
    expect(outcome).toEqual({ status: 'denied', code: 'action_not_allowed' });
    expect(phasesOf(stack, 'p-3')).toEqual(['denied']);
    expect(stack.server.store.inbox.some((e) => e.type === 'permission.checked')).toBe(false);
  });

  it('send_directive to a queued-only session executes honestly (202 = queued)', async () => {
    stack = await startStack();
    const action: ProposedAction = { kind: 'send_directive', sessionId: 'ghost', text: 'ship it' };
    const outcome = await stack.server.agentActions.execute(action, meta(4));
    expect(outcome).toMatchObject({ status: 'executed' });
    expect((outcome as any).result.queued).toBe(true);
    expect(
      stack.server.store.inbox.some(
        (e) => e.type === 'directive.queued' && e.actor === 'agent' && e.sessionId === 'ghost',
      ),
    ).toBe(true);
  });

  it('confirm-class proposal parks a card; reject audits denied(rejected)', async () => {
    stack = await startStack();
    const action: ProposedAction = { kind: 'interrupt_session', sessionId: 'ghost' };
    const outcome = await stack.server.agentActions.execute(action, meta(5));
    expect(outcome).toMatchObject({ status: 'pending' });
    const confirmationId = (outcome as any).confirmationId;

    // Inbox shows the origin-tagged card; the plain queue shows it too.
    const inbox = await api(stack, 'GET', '/api/agent/approvals');
    expect(inbox.body.pending).toHaveLength(1);
    expect(inbox.body.pending[0]).toMatchObject({
      id: confirmationId,
      action: 'session.interrupt',
      actor: 'agent',
      origin: { kind: 'manage-agent', proposalId: 'p-5', turnId: 't-1' },
    });

    const rejected = await api(stack, 'POST', `/api/agent/approvals/${confirmationId}/resolve`, {
      body: { decision: 'reject' },
      user: true,
    });
    expect(rejected.status).toBe(200);
    expect(rejected.body.rejected).toBe(true);
    expect(phasesOf(stack, 'p-5')).toEqual(['proposed', 'pending', 'denied']);
    const emptied = await api(stack, 'GET', '/api/agent/approvals');
    expect(emptied.body.pending).toHaveLength(0);
  });

  it('an approved action that fails at run time is audited as failed (honest)', async () => {
    stack = await startStack();
    const action: ProposedAction = { kind: 'interrupt_session', sessionId: 'ghost' };
    const outcome = await stack.server.agentActions.execute(action, meta(6));
    const confirmationId = (outcome as any).confirmationId;
    const approved = await api(stack, 'POST', `/api/agent/approvals/${confirmationId}/resolve`, {
      body: { decision: 'approve' },
      user: true,
    });
    expect(approved.status).toBe(200);
    // The ghost session does not exist → the run is a 404, reported verbatim.
    expect(approved.body.resultStatus).toBe(404);
    expect(approved.body.result.code).toBe('not_found');
    expect(phasesOf(stack, 'p-6')).toEqual(['proposed', 'pending', 'approved', 'failed']);
  });

  it('driver capability honesty: unsupported op → denied adapter_unsupported', async () => {
    stack = await startStack({ permissions: { 'plan.approve': 'autonomous' } });
    const spawned = await api(stack, 'POST', '/api/sessions', {
      body: { adapterId: 'generic-pty', cwd: stack.stateDir, cmd: 'sh' },
      user: true,
    });
    expect(spawned.status).toBe(201);
    const action: ProposedAction = { kind: 'approve_plan', sessionId: spawned.body.sessionId };
    const outcome = await stack.server.agentActions.execute(action, meta(7));
    // The generic PTY driver throws a typed AdapterUnsupportedError.
    expect(outcome).toEqual({ status: 'denied', code: 'adapter_unsupported' });
    expect(phasesOf(stack, 'p-7')).toEqual(['proposed', 'failed']);
  }, 15000);

  it('the agent inbox filters to manage-agent origin; one queue underneath', async () => {
    stack = await startStack({ permissions: { 'directive.send': 'confirm' } });
    // A transport-actor confirmation (no origin)…
    const transport = await api(stack, 'POST', '/api/directive', {
      body: { sessionId: 'x', text: 'gated text' },
      actor: 'agent',
    });
    expect(transport.status).toBe(202);
    // …and an agent-proposal confirmation (origin-tagged).
    const outcome = await stack.server.agentActions.execute(
      { kind: 'interrupt_session', sessionId: 'ghost' },
      meta(8),
    );
    expect(outcome).toMatchObject({ status: 'pending' });

    const all = await api(stack, 'GET', '/api/confirmations');
    expect(all.body.pending).toHaveLength(2);
    const agentInbox = await api(stack, 'GET', '/api/agent/approvals');
    expect(agentInbox.body.pending).toHaveLength(1);
    expect(agentInbox.body.pending[0].origin.proposalId).toBe('p-8');
  });
});
