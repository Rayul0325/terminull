/**
 * Server-contract integration tests: in-process HTTP on an ephemeral port,
 * real EventStore on a tmpdir, real SessionHost (real PTYs) on a tmpdir
 * socket. Nothing here reads the real home directory.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { api, startStack, waitFor, type Stack } from './harness';

const GOLDEN = fileURLToPath(
  new URL('../../adapters/claude/test/fixtures/golden-session.jsonl', import.meta.url),
);

let stack: Stack;

afterEach(async () => {
  await stack.close();
});

// ---------------------------------------------------------------------------
// health + discovery + smoke page
// ---------------------------------------------------------------------------

describe('boot surface', () => {
  it('health reports real seq/host state; discovery file is 0600 with the real port', async () => {
    stack = await startStack();
    const health = await api(stack, 'GET', '/api/health');
    expect(health.status).toBe(200);
    expect(health.body.ok).toBe(true);
    expect(health.body.host.connected).toBe(true);
    expect(health.body.sessions).toEqual({ count: 0, known: true });
    expect(typeof health.body.seq).toBe('number');

    const discoveryPath = path.join(stack.stateDir, 'server.json');
    const stat = fs.statSync(discoveryPath);
    expect(stat.mode & 0o777).toBe(0o600);
    const discovery = JSON.parse(fs.readFileSync(discoveryPath, 'utf8'));
    expect(discovery.port).toBe(stack.port);
    expect(discovery.pid).toBe(process.pid);
    expect(discovery.protocol).toBe(1);
    expect(typeof discovery.coreVersion).toBe('string');

    await stack.server.close();
    expect(fs.existsSync(discoveryPath)).toBe(false);
  });

  it('serves the smoke page at / with the fleet-fetch script', async () => {
    stack = await startStack();
    const res = await fetch(`${stack.base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('Terminull');
    expect(html).toContain('/api/fleet');
  });
});

// ---------------------------------------------------------------------------
// hook ingress: forgery gate + masking
// ---------------------------------------------------------------------------

describe('POST /api/events (hook ingress)', () => {
  it('accepts postable types, masks secrets, stamps the hook actor', async () => {
    stack = await startStack();
    const posted = await api(stack, 'POST', '/api/events', {
      body: {
        type: 'session.report',
        sessionId: 'hook-sess',
        payload: { text: 'key sk-abcdef1234567890 done' },
      },
    });
    expect(posted.status).toBe(201);
    const events = await api(stack, 'GET', '/api/events?since=0');
    const ev = events.body.events.find((e: any) => e.type === 'session.report');
    expect(ev.actor).toBe('hook');
    expect(ev.payload.text).toContain('[REDACTED]');
    expect(ev.payload.text).not.toContain('sk-abcdef');
  });

  it('rejects guarded types with an honest 400 code', async () => {
    stack = await startStack();
    for (const type of ['directive.delivered', 'permission.settings_changed']) {
      const res = await api(stack, 'POST', '/api/events', { body: { type } });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ code: 'not_postable', type });
    }
  });

  it('rejects a state-changing POST with a spoofed Origin', async () => {
    stack = await startStack();
    const res = await api(stack, 'POST', '/api/events', {
      body: { type: 'session.report' },
      origin: 'http://evil.example',
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('origin_mismatch');
  });
});

// ---------------------------------------------------------------------------
// seq resync: WS stream + REST catch-up
// ---------------------------------------------------------------------------

describe('WS /ws + GET /api/events resync', () => {
  it('streams appends in order; a dropped client catches up exactly', async () => {
    stack = await startStack();
    const ws = new WebSocket(`ws://127.0.0.1:${stack.port}/ws`);
    const messages: any[] = [];
    ws.on('message', (data) => messages.push(JSON.parse(String(data))));
    await waitFor(() => messages.length >= 1);
    expect(messages[0].t).toBe('hello');
    expect(messages[0].proto).toBe(1);
    const helloSeq = messages[0].seq;

    stack.server.store.append('session.activity', { sessionId: 'a' });
    stack.server.store.append('session.activity', { sessionId: 'b' });
    stack.server.store.append('session.activity', { sessionId: 'c' });
    await waitFor(() => messages.length >= 4);
    const streamed = messages.slice(1).map((m) => m.event);
    expect(streamed.map((e) => e.sessionId)).toEqual(['a', 'b', 'c']);
    expect(streamed.map((e) => e.seq)).toEqual([helloSeq + 1, helloSeq + 2, helloSeq + 3]);

    // Drop the socket, append two more, resync over REST.
    ws.close();
    await waitFor(() => ws.readyState === WebSocket.CLOSED);
    stack.server.store.append('session.activity', { sessionId: 'd' });
    stack.server.store.append('session.activity', { sessionId: 'e' });
    const lastSeen = streamed[2].seq;
    const resync = await api(stack, 'GET', `/api/events?since=${lastSeen}`);
    expect(resync.status).toBe(200);
    expect(resync.body.gap).toBe(false);
    expect(resync.body.events.map((e: any) => e.sessionId)).toEqual(['d', 'e']);
  });
});

// ---------------------------------------------------------------------------
// gate: forbidden / confirm / approve
// ---------------------------------------------------------------------------

describe('permission gate', () => {
  it('403s an agent on a forbidden action and audits permission.checked', async () => {
    stack = await startStack({ permissions: { 'directive.send': 'forbidden' } });
    const res = await api(stack, 'POST', '/api/directive', {
      body: { sessionId: 'x', text: 'do things' },
      actor: 'agent',
    });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ code: 'forbidden', action: 'directive.send' });
    const checked = stack.server.store.inbox.filter((e) => e.type === 'permission.checked');
    expect(checked.length).toBe(1);
    expect(checked[0]!.payload).toMatchObject({
      action: 'directive.send',
      decision: 'no',
      requestActor: 'agent',
    });
    // No directive event was minted.
    expect(stack.server.store.inbox.some((e) => e.type.startsWith('directive.'))).toBe(false);
  });

  it('confirm-class action parks a pending confirmation; user approval executes it', async () => {
    stack = await startStack({ permissions: { 'directive.send': 'confirm' } });
    // Spawn a live generic session (user actor: session.spawn resolves yes).
    const spawned = await api(stack, 'POST', '/api/sessions', {
      body: { adapterId: 'generic-pty', cwd: stack.stateDir, cmd: 'sh' },
      user: true,
    });
    expect(spawned.status).toBe(201);
    const sessionId = spawned.body.sessionId;

    const gated = await api(stack, 'POST', '/api/directive', {
      body: { sessionId, text: 'echo hello-from-directive' },
      actor: 'agent',
    });
    expect(gated.status).toBe(202);
    expect(gated.body.code).toBe('pending_confirmation');
    const confirmationId = gated.body.confirmationId;
    expect(
      stack.server.store.inbox.some(
        (e) =>
          e.type === 'confirmation.pending' && (e.payload as any).confirmationId === confirmationId,
      ),
    ).toBe(true);

    const listed = await api(stack, 'GET', '/api/confirmations');
    expect(listed.body.pending.map((p: any) => p.id)).toContain(confirmationId);

    // A non-user actor may NOT approve.
    const denied = await api(stack, 'POST', `/api/confirmations/${confirmationId}/approve`, {
      actor: 'agent',
    });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('user_required');

    // The user approves → the queued directive actually executes (delivered).
    const approved = await api(stack, 'POST', `/api/confirmations/${confirmationId}/approve`, {
      user: true,
    });
    expect(approved.status).toBe(200);
    expect(approved.body.approved).toBe(true);
    expect(approved.body.resultStatus).toBe(200);
    expect(approved.body.result.delivered).toBe(true);
    expect(
      stack.server.store.inbox.some(
        (e) => e.type === 'directive.delivered' && e.sessionId === sessionId,
      ),
    ).toBe(true);
    expect(stack.server.store.inbox.some((e) => e.type === 'confirmation.approved')).toBe(true);
  }, 15000);

  it('reject discards the queued action without executing it', async () => {
    stack = await startStack({ permissions: { 'directive.send': 'confirm' } });
    const gated = await api(stack, 'POST', '/api/directive', {
      body: { sessionId: 'ghost', text: 'never runs' },
      actor: 'agent',
    });
    const rejected = await api(
      stack,
      'POST',
      `/api/confirmations/${gated.body.confirmationId}/reject`,
      { user: true },
    );
    expect(rejected.status).toBe(200);
    expect(rejected.body.rejected).toBe(true);
    expect(stack.server.store.inbox.some((e) => e.type.startsWith('directive.'))).toBe(false);
    const again = await api(
      stack,
      'POST',
      `/api/confirmations/${gated.body.confirmationId}/approve`,
      { user: true },
    );
    expect(again.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// spawn / fleet / delete (full stack: real PTY through paneld)
// ---------------------------------------------------------------------------

describe('session lifecycle', () => {
  it('spawns sh, shows it live in the fleet, enforces the two-step delete', async () => {
    stack = await startStack();
    const spawned = await api(stack, 'POST', '/api/sessions', {
      body: { adapterId: 'generic-pty', cwd: stack.stateDir, cmd: 'sh', label: 'proof-sh' },
      user: true,
    });
    expect(spawned.status).toBe(201);
    expect(spawned.body.label).toBe('proof-sh');
    const sessionId = spawned.body.sessionId;

    const fleet = await api(stack, 'GET', '/api/fleet');
    const entry = fleet.body.sessions.find((s: any) => s.id === sessionId);
    expect(entry).toMatchObject({
      origin: 'paneld',
      tool: 'generic-pty',
      live: true,
      title: 'proof-sh',
    });
    // Collector statuses are reported per adapter, none dropped.
    const adapterIds = fleet.body.adapters.map((a: any) => a.adapterId).sort();
    expect(adapterIds).toEqual(['claude', 'generic-pty']);

    // Two-step: no phrase → 400, wrong phrase → 400, right phrase → killed.
    const noPhrase = await api(stack, 'DELETE', `/api/sessions/${sessionId}`, {
      body: {},
      user: true,
    });
    expect(noPhrase.status).toBe(400);
    expect(noPhrase.body.code).toBe('confirm_phrase_mismatch');
    const wrong = await api(stack, 'DELETE', `/api/sessions/${sessionId}`, {
      body: { confirmPhrase: 'nope' },
      user: true,
    });
    expect(wrong.status).toBe(400);

    const deleted = await api(stack, 'DELETE', `/api/sessions/${sessionId}`, {
      body: { confirmPhrase: 'proof-sh' },
      user: true,
    });
    expect(deleted.status).toBe(200);
    expect(deleted.body).toMatchObject({ deleted: true, exited: true });
    await waitFor(() =>
      stack.server.store.inbox.some((e) => e.type === 'session.end' && e.sessionId === sessionId),
    );
    expect(
      stack.server.store.inbox.some((e) => e.type === 'session.end' && e.sessionId === sessionId),
    ).toBe(true);

    const after = await api(stack, 'GET', '/api/fleet');
    const gone = after.body.sessions.find((s: any) => s.id === sessionId);
    expect(gone.live).toBe(false);
  }, 20000);

  it('rejects a generic cmd outside the allowlist', async () => {
    stack = await startStack();
    const res = await api(stack, 'POST', '/api/sessions', {
      body: { adapterId: 'generic-pty', cwd: stack.stateDir, cmd: 'rm' },
      user: true,
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('cmd_not_allowed');
  });

  it('rejects an unknown adapter honestly', async () => {
    stack = await startStack();
    const res = await api(stack, 'POST', '/api/sessions', {
      body: { adapterId: 'nope', cwd: stack.stateDir },
      user: true,
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('unknown_adapter');
  });
});

// ---------------------------------------------------------------------------
// transcript: claude parser over a constructed fixture home
// ---------------------------------------------------------------------------

describe('GET /api/sessions/:sid/transcript', () => {
  it('reads a claude fixture transcript through the wired parser', async () => {
    stack = await startStack();
    // Fixture home: a live claude registry entry (this test process's pid)
    // pointing at a golden transcript. Never the real ~/.claude.
    const claudeHome = path.join(stack.collectHome, '.claude');
    const cwd = path.join(stack.stateDir, 'proj');
    fs.mkdirSync(path.join(claudeHome, 'sessions'), { recursive: true });
    const projDir = path.join(claudeHome, 'projects', cwd.replaceAll('/', '-'));
    fs.mkdirSync(projDir, { recursive: true });
    fs.copyFileSync(GOLDEN, path.join(projDir, 'fix-sess-1.jsonl'));
    fs.writeFileSync(
      path.join(claudeHome, 'sessions', '12345.json'),
      JSON.stringify({ pid: process.pid, sessionId: 'fix-sess-1', cwd, updatedAt: Date.now() }),
    );

    const fleet = await api(stack, 'GET', '/api/fleet');
    const found = fleet.body.sessions.find((s: any) => s.id === 'fix-sess-1');
    expect(found).toMatchObject({ tool: 'claude', origin: 'adapter', live: true });

    const win = await api(stack, 'GET', '/api/sessions/fix-sess-1/transcript');
    expect(win.status).toBe(200);
    expect(win.body.supported).toBe(true);
    expect(win.body.items.length).toBeGreaterThan(0);
    expect(win.body.items.some((i: any) => i.text?.includes('hello there'))).toBe(true);
    expect(win.body.cursor.offset).toBeGreaterThan(0);

    // Cursor continuation: no repeats, cursor stays put. The golden fixture
    // deliberately ends in a TORN line, so the parser honestly reports
    // done:false (bytes remain past the last complete record).
    const next = await api(
      stack,
      'GET',
      `/api/sessions/fix-sess-1/transcript?cursor=${win.body.cursor.offset}`,
    );
    expect(next.body.supported).toBe(true);
    expect(next.body.items).toEqual([]);
    expect(next.body.cursor.offset).toBe(win.body.cursor.offset);
    expect(next.body.done).toBe(false);
  });

  it('is honest about sessions without a transcript', async () => {
    stack = await startStack();
    const spawned = await api(stack, 'POST', '/api/sessions', {
      body: { adapterId: 'generic-pty', cwd: stack.stateDir, cmd: 'sh' },
      user: true,
    });
    const res = await api(stack, 'GET', `/api/sessions/${spawned.body.sessionId}/transcript`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ supported: false, reason: 'no_transcript' });

    const missing = await api(stack, 'GET', '/api/sessions/ghost/transcript');
    expect(missing.status).toBe(404);
  }, 15000);
});
