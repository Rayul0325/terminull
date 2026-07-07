/**
 * Directive delivery to a DISCOVERED (non-paneld-owned) local tmux session.
 *
 * The gap this closes: a session the collector merely discovered (origin
 * 'adapter', no serverSessionId) used to always queue — deliverDirective's
 * direct path only fired for paneld-OWNED sessions. Now, when such a session
 * runs in a local tmux pane, the directive is delivered via non-adopting
 * `tmux send-keys`. tmux itself is stubbed here (CI has no pane for our pid);
 * the pane-resolution logic is unit-tested in session-host/tmux-resolve.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  pane: '%1' as string | null,
  sendCalls: [] as { target: string; text: string }[],
}));

// Partial mock: keep SessionHost (the harness spins up a real one) and every
// other export real; stub ONLY the tmux helpers deliverDirective calls.
vi.mock('@terminull/session-host', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@terminull/session-host')>();
  return {
    ...actual,
    tmux: {
      ...actual.tmux,
      resolveTmuxBin: () => 'tmux',
      resolvePaneByPid: async () => hoisted.pane,
      sendText: async (_bin: string, target: string, text: string) => {
        hoisted.sendCalls.push({ target, text });
      },
    },
  };
});

import { api, startStack, type Stack } from './harness';

let stack: Stack;

/** Plant a LIVE claude session registry entry the collector will discover. */
function plantLiveSession(collectHome: string, sessionId: string, pid: number): void {
  const sessionsDir = path.join(collectHome, '.claude', 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionsDir, `${sessionId}.json`),
    JSON.stringify({ sessionId, pid, cwd: collectHome, updatedAt: Date.now() }),
  );
}

beforeEach(() => {
  hoisted.pane = '%1';
  hoisted.sendCalls = [];
});

afterEach(async () => {
  await stack?.close();
});

describe('directive → discovered local tmux session', () => {
  it('delivers via tmux send-keys when the pid resolves to a pane', async () => {
    stack = await startStack();
    const sessionId = 'disc-sess-1';
    // process.pid is genuinely alive, so the collector marks the session live.
    plantLiveSession(stack.collectHome, sessionId, process.pid);

    const res = await api(stack, 'POST', '/api/directive', {
      body: { sessionId, text: 'ping-from-gui' },
      user: true,
    });

    expect(res.status).toBe(200);
    expect(res.body.delivered).toBe(true);
    // The stubbed send-keys received the exact text at the resolved pane.
    expect(hoisted.sendCalls).toEqual([{ target: '%1', text: 'ping-from-gui' }]);
    const delivered = stack.server.store.inbox.filter(
      (e) => e.type === 'directive.delivered' && e.sessionId === sessionId,
    );
    expect(delivered.length).toBe(1);
    expect((delivered[0]!.payload as { method?: string }).method).toBe('tmux-sendkeys');
  });

  it('stays honest (queues, no fake delivery) when the pid is not in any tmux pane', async () => {
    hoisted.pane = null; // resolvePaneByPid finds no pane
    stack = await startStack();
    const sessionId = 'disc-sess-2';
    plantLiveSession(stack.collectHome, sessionId, process.pid);

    const res = await api(stack, 'POST', '/api/directive', {
      body: { sessionId, text: 'ping-no-pane' },
      user: true,
    });

    expect(res.status).toBe(202);
    expect(res.body.queued).toBe(true);
    expect(hoisted.sendCalls).toEqual([]); // never sent
    expect(
      stack.server.store.inbox.some(
        (e) => e.type === 'directive.delivered' && e.sessionId === sessionId,
      ),
    ).toBe(false);
    expect(
      stack.server.store.inbox.some(
        (e) => e.type === 'directive.queued' && e.sessionId === sessionId,
      ),
    ).toBe(true);
  });
});
