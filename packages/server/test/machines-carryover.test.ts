/**
 * M9 carried-over M8 fixes (contract S7–S9), against scripted fake agents
 * (local node children — never ssh, never a real remote):
 *
 *  S7 — remote spawn failures preserve the HOST's error detail end-to-end;
 *  S8 — relay stderr actually lands in `<stateDir>/machines/<id>.log`, masked;
 *  S9 — a `/pty` viewer that disconnects while the attachment relay is still
 *       dialing must not orphan the relay child (census via pid files).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MachineConfig } from '@terminull/shared';
import { api, expectEventually, startStack, type Stack } from './harness';

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fake-agent.mjs',
);

let stack: Stack;
let pidDir: string;

function fakeMachine(id: string, extra: string[]): MachineConfig {
  return {
    id,
    label: id,
    transport: { kind: 'stdio', cmd: process.execPath, args: [FIXTURE, ...extra] },
    enabled: true,
  };
}

/** Live fake-agent children for machine m1, from its pid-file census. */
function aliveRelayCount(): number {
  let alive = 0;
  for (const name of fs.readdirSync(pidDir)) {
    try {
      process.kill(Number(name), 0);
      alive++;
    } catch {
      // exited — pid file is just the census record
    }
  }
  return alive;
}

async function machineState(id: string): Promise<string | undefined> {
  const res = await api(stack, 'GET', '/api/machines', { user: true });
  return (res.body.machines as { id: string; state: string }[]).find((m) => m.id === id)?.state;
}

beforeAll(async () => {
  pidDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn9c-'));
  stack = await startStack({
    machines: [
      // m1: slow `attached` replies + pid census — the S9 orphan window. The
      // fixed spawn sid (paired with --session) lets FRESH relay children —
      // separate processes with separate session maps — attach to the spawn.
      fakeMachine('m1', [
        '--session=7',
        '--spawn-sid=7',
        '--attach-delay=700',
        `--pid-dir=${pidDir}`,
      ]),
      // m2: writes one stderr line at boot — the S8 sink probe. The marked
      // token MUST come out masked in the log.
      fakeMachine('m2', [
        '--stderr=relay warning: token=abcdefghijklmnopqrstuvwxyz012345 disk almost full',
      ]),
      // m3: refuses every spawn with a host-detailed error — the S7 probe.
      fakeMachine('m3', ['--fail-spawn']),
    ],
    machineTimings: { heartbeatMs: 60_000, requestTimeoutMs: 5000 },
  });
  await expectEventually(
    async () =>
      (await api(stack, 'GET', '/api/machines', { user: true })).body.machines as {
        id: string;
        state: string;
      }[],
    (ms) => ['m1', 'm2', 'm3'].every((id) => ms.find((m) => m.id === id)?.state === 'connected'),
    { timeoutMs: 15_000 },
  );
}, 30_000);

afterAll(async () => {
  await stack?.close();
  fs.rmSync(pidDir, { recursive: true, force: true });
}, 20_000);

describe('S7 — remote spawn error detail end-to-end', () => {
  it('502 spawn_failed carries hostCode AND the masked host message', async () => {
    const res = await api(stack, 'POST', '/api/sessions', {
      user: true,
      body: { adapterId: 'generic-pty', cwd: os.tmpdir(), cmd: 'sh', machine: 'm3' },
    });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({
      code: 'spawn_failed',
      hostCode: 'SPAWN_FAILED',
      detail: 'posix_spawnp failed: /usr/bin/zsh not found on host',
    });
  });
});

describe('S8 — machines/<id>.log stderr sink', () => {
  it('relay stderr lands in the per-machine log file, secrets masked', async () => {
    const logFile = path.join(stack.stateDir, 'machines', 'm2.log');
    const content = await expectEventually(
      () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : ''),
      (s) => s.includes('disk almost full'),
      { timeoutMs: 10_000 },
    );
    expect(content).toContain('relay warning');
    expect(content).toContain('disk almost full');
    expect(content).toContain('[REDACTED]');
    expect(content).not.toContain('abcdefghijklmnopqrstuvwxyz012345');
    expect(fs.statSync(logFile).mode & 0o777).toBe(0o600);
  });
});

describe('S9 — attach relay child reaped on ws-close-mid-dial', () => {
  it('closing /pty before `attached` kills the in-flight relay child', async () => {
    // One live relay so far: m1's control link.
    expect(aliveRelayCount()).toBe(1);

    const spawned = await api(stack, 'POST', '/api/sessions', {
      user: true,
      body: { adapterId: 'generic-pty', cwd: os.tmpdir(), cmd: 'sh', machine: 'm1' },
    });
    expect(spawned.status).toBe(201);

    // Open the viewer and close it IMMEDIATELY — the attachment relay is
    // still dialing (fake agent delays `attached` by 700ms).
    const ws = new WebSocket(`ws://127.0.0.1:${stack.port}/pty?sid=${spawned.body.sessionId}`, {
      headers: { authorization: `Bearer ${stack.token}` },
    });
    const messages: unknown[] = [];
    ws.on('message', (data, isBinary) => {
      if (!isBinary) messages.push(JSON.parse(String(data)));
    });
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    // The dial has started (a second relay child registered its pid file).
    await expectEventually(() => fs.readdirSync(pidDir).length, (n) => n >= 2, {
      timeoutMs: 10_000,
    });
    ws.close();

    // The in-flight relay child must be reaped once the dial completes —
    // census back down to the control link alone, and the viewer never got
    // an `attached` frame it could not use.
    const alive = await expectEventually(aliveRelayCount, (n) => n === 1, { timeoutMs: 10_000 });
    expect(alive).toBe(1);
    expect(messages.some((m) => (m as { t?: string }).t === 'attached')).toBe(false);

    // Machine health unaffected: m1 stays connected and a NORMAL viewer still
    // attaches fine afterwards (no over-eager reaping).
    expect(await machineState('m1')).toBe('connected');
    const ws2 = new WebSocket(`ws://127.0.0.1:${stack.port}/pty?sid=${spawned.body.sessionId}`, {
      headers: { authorization: `Bearer ${stack.token}` },
    });
    const texts: { t?: string }[] = [];
    ws2.on('message', (data, isBinary) => {
      if (!isBinary) texts.push(JSON.parse(String(data)) as { t?: string });
    });
    await new Promise<void>((resolve, reject) => {
      ws2.on('open', () => resolve());
      ws2.on('error', reject);
    });
    const ws2Texts = await expectEventually(() => texts, (t) => t.some((m) => m.t === 'attached'), {
      timeoutMs: 10_000,
    });
    expect(ws2Texts.some((m) => m.t === 'attached')).toBe(true);
    ws2.terminate();
    // …and that healthy viewer's relay is a THIRD child, reaped on terminate.
    const finalAlive = await expectEventually(aliveRelayCount, (n) => n === 1, {
      timeoutMs: 10_000,
    });
    expect(finalAlive).toBe(1);
  }, 40_000);
});
