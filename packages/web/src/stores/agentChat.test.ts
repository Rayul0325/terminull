/**
 * Supervisor-chat stream-reduce tests: a 202 marks the user message ACCEPTED
 * (never answered), speech chunks accumulate per turn until final, action
 * chips track the latest phase per proposal, and interleaved turns stay
 * separate. All fetches mocked — no server, no real brains, no CLIs.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Envelope } from '@terminull/shared';
import { setFetchImpl } from '../api/client';
import { useAgentChatStore, type AgentChatMessage } from './agentChat';

let restoreFetch: (() => void) | null = null;
let seq = 0;

afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
  seq = 0;
  useAgentChatStore.setState({
    messages: [],
    truncated: false,
    chips: [],
    runtimeState: null,
    runtimeReason: undefined,
    status: null,
    statusErrorCode: null,
    models: null,
    modelsErrorCode: null,
    selectedModel: null,
    draft: '',
  });
});

function ev(type: string, payload: unknown): Envelope {
  seq += 1;
  return { seq, ts: 1000 + seq, v: 1, type, machine: 'test', actor: 'agent', payload };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('agent chat store', () => {
  it('send: 202 turns the message accepted with the turnId — never more', async () => {
    restoreFetch = setFetchImpl(() => Promise.resolve(json(202, { turnId: 't-1' })));
    const store = useAgentChatStore.getState();
    store.setDraft('spawn a worker');
    await store.send();
    const messages = useAgentChatStore.getState().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ kind: 'user', state: 'accepted', turnId: 't-1' });
    expect(useAgentChatStore.getState().draft).toBe('');
  });

  it('send failure restores the draft and surfaces the code', async () => {
    restoreFetch = setFetchImpl(() => Promise.resolve(json(409, { code: 'agent_disabled' })));
    const store = useAgentChatStore.getState();
    store.setDraft('hello');
    await store.send();
    const messages = useAgentChatStore.getState().messages;
    expect(messages[0]).toMatchObject({
      kind: 'user',
      state: 'failed',
      errorCode: 'agent_disabled',
    });
    expect(useAgentChatStore.getState().draft).toBe('hello');
  });

  it('speech chunks accumulate per turn and close on final', () => {
    const store = useAgentChatStore.getState();
    store.applyEvents([ev('agent.speech', { turnId: 't-1', text: '먼저 ', final: false })]);
    store.applyEvents([ev('agent.speech', { turnId: 't-1', text: '세션을 봅니다', final: true })]);
    const messages = useAgentChatStore.getState().messages;
    expect(messages).toHaveLength(1);
    const m = messages[0] as AgentChatMessage;
    expect(m.text).toBe('먼저 세션을 봅니다');
    expect(m.final).toBe(true);
  });

  it('a chunk after final opens a new bubble instead of rewriting history', () => {
    const store = useAgentChatStore.getState();
    store.applyEvents([
      ev('agent.speech', { turnId: 't-1', text: 'one', final: true }),
      ev('agent.speech', { turnId: 't-1', text: 'two', final: false }),
    ]);
    const messages = useAgentChatStore.getState().messages;
    expect(messages).toHaveLength(2);
    expect((messages[0] as AgentChatMessage).text).toBe('one');
    expect((messages[1] as AgentChatMessage).final).toBe(false);
  });

  it('interleaved turns keep separate bubbles', () => {
    const store = useAgentChatStore.getState();
    store.applyEvents([
      ev('agent.speech', { turnId: 't-1', text: 'a', final: false }),
      ev('agent.speech', { turnId: 't-2', text: 'x', final: false }),
      ev('agent.speech', { turnId: 't-1', text: 'b', final: true }),
    ]);
    const texts = useAgentChatStore.getState().messages.map((m) => (m as AgentChatMessage).text);
    expect(texts).toEqual(['ab', 'x']);
  });

  it('action chips keep the LATEST phase per proposal', () => {
    const base = {
      proposalId: 'p-1',
      turnId: 't-1',
      actionKind: 'spawn_session',
      permissionAction: 'session.spawn',
    };
    const store = useAgentChatStore.getState();
    store.applyEvents([
      ev('agent.action', { ...base, phase: 'proposed' }),
      ev('agent.action', { ...base, phase: 'pending', confirmationId: 'c-1' }),
    ]);
    let chips = useAgentChatStore.getState().chips;
    expect(chips).toHaveLength(1);
    expect(chips[0]).toMatchObject({ phase: 'pending', confirmationId: 'c-1' });
    store.applyEvents([ev('agent.action', { ...base, phase: 'denied', resultCode: 'rejected' })]);
    chips = useAgentChatStore.getState().chips;
    expect(chips[0]).toMatchObject({ phase: 'denied', resultCode: 'rejected' });
  });

  it('agent.state updates the runtime chip with its reason code', () => {
    const store = useAgentChatStore.getState();
    store.applyEvents([ev('agent.state', { state: 'error', reason: 'brain_error' })]);
    expect(useAgentChatStore.getState().runtimeState).toBe('error');
    expect(useAgentChatStore.getState().runtimeReason).toBe('brain_error');
  });

  it('status fetch keeps brain availability verbatim (unverified stays unverified)', async () => {
    restoreFetch = setFetchImpl(() =>
      Promise.resolve(
        json(200, {
          state: 'idle',
          enabled: true,
          brain: { id: 'fake', availability: 'unverified' },
          caps: { maxTurnsPerChat: 4, maxActionsPerTurn: 5, maxBudgetUsdPerDay: null },
          budget: { spentUsd: null, capUsd: null },
          pendingApprovals: 0,
        }),
      ),
    );
    await useAgentChatStore.getState().refreshStatus();
    expect(useAgentChatStore.getState().status?.brain.availability).toBe('unverified');
  });

  it('model registry provenance passes through; failure is an honest code', async () => {
    restoreFetch = setFetchImpl(() =>
      Promise.resolve(
        json(200, { models: [{ id: 'sonnet', label: 'Sonnet', source: 'fallback' }] }),
      ),
    );
    await useAgentChatStore.getState().loadModels('claude');
    expect(useAgentChatStore.getState().models).toEqual([
      { id: 'sonnet', label: 'Sonnet', source: 'fallback' },
    ]);
    restoreFetch();
    restoreFetch = setFetchImpl(() =>
      Promise.resolve(json(422, { code: 'adapter_unsupported', operation: 'models' })),
    );
    await useAgentChatStore.getState().loadModels('generic-pty');
    expect(useAgentChatStore.getState().models).toBeNull();
    expect(useAgentChatStore.getState().modelsErrorCode).toBe('adapter_unsupported');
  });
});
