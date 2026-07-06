/**
 * End-to-end: run a REAL agy headless one-shot turn via {@link buildAgyOneshotCommand}.
 *
 * Env-gated — skipped by default so CI (no agy binary/auth) stays honest. Run
 * locally with:  TERMINULL_E2E_AGY=1 pnpm --filter @terminull/adapter-agy test
 * Uses a one-word prompt and a short --print-timeout (tiny budget). An auth /
 * network failure is an ACCEPTABLE outcome — the assertion is only that the
 * command we assemble drives the real binary to a terminal state (it neither
 * hangs past the watchdog nor is mis-assembled); the response body is not asserted.
 *
 * NOTE: stdin is DETACHED (`stdio: ['ignore', …]`). agy blocks on an open stdin
 * even in `-p` mode (verified 2026-07-06); the production one-shot path must do
 * the same — see {@link buildAgyOneshotCommand}.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAgyOneshotCommand } from '../src/driver';

const RUN = !!process.env['TERMINULL_E2E_AGY'];

function realAgyPath(): string | null {
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'agy'),
    ...(process.env['PATH'] ?? '')
      .split(path.delimiter)
      .filter((d) => d.length > 0)
      .map((d) => path.join(d, 'agy')),
  ];
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {
      /* not here */
    }
  }
  return null;
}

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Spawn a real one-shot with stdin DETACHED and a hard watchdog kill. */
function runOneshot(bin: string, watchdogMs = 30_000): Promise<RunResult> {
  const { cmd, args } = buildAgyOneshotCommand({ text: 'ping', printTimeout: '10s', cmd: bin });
  return new Promise<RunResult>((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    const wd = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, watchdogMs);
    child.on('close', (code, signal) => {
      clearTimeout(wd);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
}

describe('E2E — real agy one-shot (env-gated)', () => {
  const realBin = realAgyPath();

  it.skipIf(!RUN || !realBin)(
    'drives a real one-shot to a terminal state with stdin detached (auth errors acceptable)',
    async () => {
      const res = await runOneshot(realBin as string);
      // Must NOT hang: with stdin detached agy returns promptly.
      expect(res.timedOut).toBe(false);
      // Something was produced on at least one stream (a response, or an error).
      expect((res.stdout + res.stderr).length).toBeGreaterThan(0);
    },
    45_000,
  );
});
