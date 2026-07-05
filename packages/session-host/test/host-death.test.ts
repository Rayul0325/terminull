/**
 * Host-death honesty: when the daemon dies, its PTY children die with it, and
 * a restarted daemon must advertise a NEW bootId and an EMPTY session list —
 * never ghost sessions it cannot actually serve.
 *
 * This test runs the daemon as a REAL subprocess (node dist/bin.js) and
 * SIGKILLs it, so it exercises the built artifact end to end.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TestClient, until } from './client';

const pkgRoot = fileURLToPath(new URL('..', import.meta.url));
const binJs = path.join(pkgRoot, 'dist', 'bin.js');
const repoRoot = path.resolve(pkgRoot, '..', '..');

let dir: string;
const procs: ChildProcess[] = [];
const clients: TestClient[] = [];

function startDaemon(stateDir: string): ChildProcess {
  const child = spawn(process.execPath, [binJs, 'start', '--state-dir', stateDir], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  procs.push(child);
  return child;
}

async function waitSocket(stateDir: string): Promise<string> {
  const sock = path.join(stateDir, 'host.sock');
  await until(() => (fs.existsSync(sock) ? true : undefined), 5000, 'host.sock');
  return sock;
}

/** True when `pid` no longer exists (kill(0) raises ESRCH). */
function processGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

beforeAll(() => {
  // The test drives the BUILT daemon; build it if this run came before tsc.
  if (!fs.existsSync(binJs)) {
    execFileSync(path.join(repoRoot, 'node_modules', '.bin', 'tsc'), ['-b'], { cwd: pkgRoot });
  }
});

afterEach(() => {
  for (const c of clients.splice(0)) c.close();
  for (const p of procs.splice(0)) {
    if (p.exitCode === null && p.signalCode === null) p.kill('SIGTERM');
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('host death honesty (real subprocess)', () => {
  it(
    'SIGKILLed host takes its PTY children down; restart reports new bootId, zero sessions',
    async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paneld-death-'));

      // --- boot 1: spawn a long-running child ---
      const daemon1 = startDaemon(dir);
      await waitSocket(dir);
      const token = fs.readFileSync(path.join(dir, 'host-token'), 'utf8').trim();

      const c1 = await TestClient.connectRetry(path.join(dir, 'host.sock'));
      clients.push(c1);
      const hello1 = await c1.hello(token);
      const bootId1 = hello1.bootId as string;

      c1.ctrl({
        t: 'spawn',
        reqId: 'r1',
        spec: {
          cmd: '/bin/sh',
          args: ['-c', 'sleep 100'],
          cwd: os.tmpdir(),
          env: {},
          cols: 80,
          rows: 24,
        },
      });
      const spawned = await c1.waitCtrl((m) => m.t === 'spawned', 3000, 'spawned');
      const childPid = spawned.pid as number;
      expect(processGone(childPid)).toBe(false); // child is genuinely alive

      // --- murder the daemon (no cleanup path runs on SIGKILL) ---
      daemon1.kill('SIGKILL');
      await until(
        () => (processGone(childPid) ? true : undefined),
        5000,
        `pty child ${childPid} to die with its host`,
      );

      // --- boot 2 on the same state dir ---
      const daemon2 = startDaemon(dir);
      await waitSocket(dir);
      const c2 = await TestClient.connectRetry(path.join(dir, 'host.sock'));
      clients.push(c2);
      const hello2 = await c2.hello(token);

      expect(hello2.hostId).toBe(hello1.hostId); // stable machine identity...
      expect(hello2.bootId).not.toBe(bootId1); // ...but a new boot...
      expect(hello2.sessions).toEqual([]); // ...and NO ghost sessions

      daemon2.kill('SIGTERM');
    },
    20_000,
  );
});
