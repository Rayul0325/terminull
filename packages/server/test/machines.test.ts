/**
 * M8 GATE ORACLE (contract §9): two paneld instances — the harness's local one
 * plus a REMOTE daemon spawned as a tracked child — with the remote reached
 * through the REAL `paneld agent` stdio relay as a local node child. No ssh
 * anywhere; every dir is a short mkdtemp under os.tmpdir().
 *
 * Proves: fleet tags sessions per machine; spawn+attach byte round-trip
 * through the relay; killing the relay makes ONLY that machine stale (honest
 * lastSeenAt, viewers closed 1011, local untouched); auto-redial recovers the
 * machine and the PRE-CUT session with ring replay; the negative surface
 * (reserved id, unknown_machine, machine_unavailable, user-only reload).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MachineConfig, MachineStatePayload } from '@terminull/shared';
import { createTerminullServer } from '../src/app';
import { api, startStack, waitFor, type Stack } from './harness';

// Resolved via the workspace layout: vitest's transform pipeline cannot
// require() the ESM-only session-host exports map at collect time.
const paneldBin = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../session-host/dist/bin.js',
);

let tmp: string;
let remoteDir: string;
let remoteDaemon: ChildProcess;
let stack: Stack;
const sockets: WebSocket[] = [];

/** Machine config pointing at the remote daemon through a LOCAL relay child. */
function marsConfig(): MachineConfig {
  return {
    id: 'mars',
    label: 'Mars',
    transport: {
      kind: 'stdio',
      cmd: process.execPath,
      args: [paneldBin, 'agent', '--state-dir', remoteDir, '--no-spawn'],
    },
    enabled: true,
  };
}

interface PtyProbe {
  ws: WebSocket;
  texts: unknown[];
  output(): string;
  closed(): { code: number } | null;
}

function connectPty(sid: string): Promise<PtyProbe> {
  const ws = new WebSocket(`ws://127.0.0.1:${stack.port}/pty?sid=${sid}&mode=rw`, {
    headers: { authorization: `Bearer ${stack.token}` },
  });
  sockets.push(ws);
  const texts: unknown[] = [];
  const bytes: Buffer[] = [];
  let closeInfo: { code: number } | null = null;
  ws.on('message', (data, isBinary) => {
    if (isBinary) bytes.push(Buffer.from(data as Buffer));
    else texts.push(JSON.parse(String(data)));
  });
  ws.on('close', (code) => {
    closeInfo = { code };
  });
  const probe: PtyProbe = {
    ws,
    texts,
    output: () => Buffer.concat(bytes).toString('utf8'),
    closed: () => closeInfo,
  };
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(probe));
    ws.on('error', reject);
    ws.on('close', () => resolve(probe));
  });
}

async function machinesList(): Promise<{ id: string; state: string; lastSeenAt: number | null }[]> {
  const res = await api(stack, 'GET', '/api/machines', { user: true });
  expect(res.status).toBe(200);
  return res.body.machines;
}

async function marsEvents(): Promise<MachineStatePayload[]> {
  const res = await api(stack, 'GET', '/api/events?since=0', { user: true });
  expect(res.status).toBe(200);
  return (res.body.events as { type: string; payload: MachineStatePayload }[])
    .filter((e) => e.type === 'machine.state' && e.payload.machineId === 'mars')
    .map((e) => e.payload);
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tn8-'));
  remoteDir = path.join(tmp, 'r');
  fs.mkdirSync(remoteDir, { recursive: true, mode: 0o700 });

  // The REMOTE machine's own daemon — a test-tracked child, never detached.
  remoteDaemon = spawn(process.execPath, [paneldBin, 'start', '--state-dir', remoteDir], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  await waitFor(() => fs.existsSync(path.join(remoteDir, 'host.sock')), 15_000);
  expect(fs.existsSync(path.join(remoteDir, 'host.sock'))).toBe(true);

  stack = await startStack({
    machines: [marsConfig()],
    machineTimings: {
      heartbeatMs: 150,
      requestTimeoutMs: 2000,
      // Generous backoff floor ON PURPOSE: it opens a deterministic stale
      // window for the step-4 assertions before auto-redial recovers mars.
      backoffMinMs: 800,
      backoffMaxMs: 1600,
      collectTimeoutMs: 2000,
    },
  });
}, 30_000);

afterAll(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await stack?.close();
  if (remoteDaemon && remoteDaemon.exitCode === null) {
    remoteDaemon.kill('SIGTERM');
    await waitFor(() => remoteDaemon.exitCode !== null, 10_000);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}, 30_000);

describe('M8 gate oracle — two paneld instances over a stdio relay', () => {
  let localSession: string;
  let marsSession: string;
  let probe: PtyProbe;
  let firstControlPid: number;

  it('1. mars connects (hostId/bootId populated); local mirror entry present', async () => {
    await waitFor(
      async () => (await machinesList()).find((m) => m.id === 'mars')?.state === 'connected',
      15_000,
      100,
    );
    const machines = await machinesList();
    expect(machines[0]?.id).toBe('local');
    const mars = machines.find((m) => m.id === 'mars') as Record<string, unknown>;
    expect(mars['state']).toBe('connected');
    expect(mars['hostId']).toBeTruthy();
    expect(mars['bootId']).toBeTruthy();
    expect(mars['lastSeenAt']).toBeTypeOf('number');
  }, 20_000);

  it('2. spawns on both machines; fleet tags every session with its machine', async () => {
    const local = await api(stack, 'POST', '/api/sessions', {
      body: { adapterId: 'generic-pty', cwd: stack.stateDir, cmd: 'sh' },
      user: true,
    });
    expect(local.status).toBe(201);
    localSession = local.body.sessionId;

    const mars = await api(stack, 'POST', '/api/sessions', {
      body: { adapterId: 'generic-pty', cwd: remoteDir, cmd: 'sh', machine: 'mars' },
      user: true,
    });
    expect(mars.status).toBe(201);
    expect(mars.body.machine).toBe('mars');
    marsSession = mars.body.sessionId;

    const fleet = await api(stack, 'GET', '/api/fleet', { user: true });
    expect(fleet.status).toBe(200);
    const sessions = fleet.body.sessions as { id: string; machine?: string; live: boolean }[];
    expect(sessions.find((s) => s.id === localSession)?.machine).toBe('local');
    expect(sessions.find((s) => s.id === marsSession)?.machine).toBe('mars');
    const machineIds = (fleet.body.machines as { id: string }[]).map((m) => m.id);
    expect(machineIds).toContain('local');
    expect(machineIds).toContain('mars');
  }, 20_000);

  it('3. attach to the mars session: byte round-trip through relay + remote daemon', async () => {
    probe = await connectPty(marsSession);
    await waitFor(() => probe.texts.length >= 1, 10_000);
    expect(probe.texts[0]).toMatchObject({ t: 'attached', readOnly: false });
    probe.ws.send(Buffer.from('echo m8-roundtrip\r'), { binary: true });
    await waitFor(() => probe.output().includes('m8-roundtrip'), 10_000);
    expect(probe.output()).toContain('m8-roundtrip');
  }, 20_000);

  it('4. relay death ⇒ ONLY mars stale{lastSeenAt}; viewers closed 1011; local serves on', async () => {
    firstControlPid = stack.server.machines.controlPid('mars')!;
    expect(firstControlPid).toBeGreaterThan(0);
    process.kill(firstControlPid, 'SIGKILL');

    // Within the heartbeat window: honest stale, never silent.
    await waitFor(
      async () => (await machinesList()).find((m) => m.id === 'mars')?.state === 'stale',
      10_000,
      50,
    );
    const machines = await machinesList();
    const mars = machines.find((m) => m.id === 'mars')!;
    expect(mars.state).toBe('stale');
    expect(mars.lastSeenAt).toBeTypeOf('number');
    // ONLY mars: the local mirror is untouched.
    expect(machines.find((m) => m.id === 'local')?.state).toBe('connected');

    const events = await marsEvents();
    const stale = events.find((e) => e.state === 'stale')!;
    expect(stale).toMatchObject({
      machineId: 'mars',
      previous: 'connected',
      state: 'stale',
      code: 'relay_exit',
    });
    expect(stale.lastSeenAt).toBeTypeOf('number');

    // The open mars viewer got an honest 1011 close.
    await waitFor(() => probe.closed() !== null, 10_000);
    expect(probe.closed()).toEqual({ code: 1011 });

    // Local keeps serving: spawn still works, fleet keeps local sessions while
    // mars contributes none (its machines[] entry is the honest signal).
    const local2 = await api(stack, 'POST', '/api/sessions', {
      body: { adapterId: 'generic-pty', cwd: stack.stateDir, cmd: 'sh' },
      user: true,
    });
    expect(local2.status).toBe(201);
    const fleet = await api(stack, 'GET', '/api/fleet', { user: true });
    const sessions = fleet.body.sessions as { id: string; machine?: string }[];
    expect(sessions.some((s) => s.machine === 'local')).toBe(true);
    expect(sessions.some((s) => s.machine === 'mars')).toBe(false);
    const marsEntry = (fleet.body.machines as { id: string; state: string }[]).find(
      (m) => m.id === 'mars',
    )!;
    expect(marsEntry.state).toBe('stale');
  }, 20_000);

  it('5. auto-redial recovers mars; the pre-cut session survives with ring replay', async () => {
    await waitFor(
      async () => (await machinesList()).find((m) => m.id === 'mars')?.state === 'connected',
      15_000,
      100,
    );
    expect(stack.server.machines.controlPid('mars')).not.toBe(firstControlPid);

    // Same remote bootId ⇒ resumed: the PRE-CUT mars session is still live.
    const fleet = await api(stack, 'GET', '/api/fleet', { user: true });
    const sessions = fleet.body.sessions as { id: string; machine?: string; live: boolean }[];
    const survivor = sessions.find((s) => s.id === marsSession);
    expect(survivor?.machine).toBe('mars');
    expect(survivor?.live).toBe(true);

    // Fresh attach replays the ring from sinceSeq 0 — step-3 bytes come back.
    const probe2 = await connectPty(marsSession);
    await waitFor(() => probe2.texts.length >= 1, 10_000);
    expect(probe2.texts[0]).toMatchObject({ t: 'attached' });
    await waitFor(() => probe2.output().includes('m8-roundtrip'), 10_000);
    expect(probe2.output()).toContain('m8-roundtrip');
    probe2.ws.close();
  }, 25_000);

  it('5b. directive to a mars session injects via the machine link (200 delivered)', async () => {
    const viewer = await connectPty(marsSession);
    await waitFor(() => viewer.texts.length >= 1, 10_000);
    const res = await api(stack, 'POST', '/api/directive', {
      body: { sessionId: marsSession, text: 'echo m8-directive' },
      user: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.delivered).toBe(true);
    // The injected bytes reached the REMOTE PTY: its output echoes back to a
    // live viewer over that viewer's own relay stream.
    await waitFor(() => viewer.output().includes('m8-directive'), 10_000);
    expect(viewer.output()).toContain('m8-directive');
    viewer.ws.close();
  }, 20_000);

  it('6. mars event order: connected → stale(relay_exit) → connected', async () => {
    const events = await marsEvents();
    const meaningful = events.filter((e) => e.state !== 'connecting');
    expect(meaningful.map((e) => `${e.state}:${e.code}`)).toEqual([
      'connected:dial_ok',
      'stale:relay_exit',
      'connected:dial_ok',
    ]);
  });

  it('7a. ServerOptions machines containing id "local" refuse to construct', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn8n-'));
    try {
      expect(() =>
        createTerminullServer({
          stateDir: dir,
          machines: [{ ...marsConfig(), id: 'local' }],
        }),
      ).toThrow(/reserved or duplicated/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('7b. spawn on an unknown machine → 400 unknown_machine', async () => {
    const res = await api(stack, 'POST', '/api/sessions', {
      body: { adapterId: 'generic-pty', cwd: remoteDir, cmd: 'sh', machine: 'unknown' },
      user: true,
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('unknown_machine');
  });

  it('7c. spawn on mars while stale → 503 machine_unavailable', async () => {
    const pid = stack.server.machines.controlPid('mars')!;
    process.kill(pid, 'SIGKILL');
    await waitFor(
      async () => (await machinesList()).find((m) => m.id === 'mars')?.state === 'stale',
      10_000,
      50,
    );
    const res = await api(stack, 'POST', '/api/sessions', {
      body: { adapterId: 'generic-pty', cwd: remoteDir, cmd: 'sh', machine: 'mars' },
      user: true,
    });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('machine_unavailable');
    expect(res.body.state).toBe('stale');
  }, 20_000);

  it('7d. machines reload is user-only: agent actor → 403 user_required', async () => {
    const res = await api(stack, 'POST', '/api/machines/reload', {
      body: {},
      actor: 'agent',
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('user_required');
  });
});
