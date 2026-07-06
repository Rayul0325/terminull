/**
 * End-to-end: drive a REAL Claude Code session through the paneld SessionHost.
 *
 * Env-gated — skipped by default so CI (no claude binary/auth) stays honest.
 * Run locally with:  TERMINULL_E2E_CLAUDE=1 pnpm --filter @terminull/adapter-claude test
 * Always uses --model sonnet with a trivial prompt (tiny budget). The session is
 * killed in teardown. Kept under 90s.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ClaudeDriver } from '../src/driver';
import { claudeKeymap } from '../src/keymap';

const RUN = !!process.env['TERMINULL_E2E_CLAUDE'];

const stripAnsi = (s: string): string =>
  // eslint-disable-next-line no-control-regex
  s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b[()][AB012]/g, '');

async function until<T>(fn: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out (${timeoutMs}ms) waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}

describe('E2E — real claude session via SessionHost (env-gated)', () => {
  let cleanup: (() => void) | null = null;
  afterAll(() => cleanup?.());

  it.skipIf(!RUN)(
    'reaches idle, accepts a prompt, and transitions busy→idle',
    async () => {
      const { SessionHost } = await import('@terminull/session-host');
      const shared = await import('@terminull/shared');
      const { FrameEncoder, FrameDecoder, HOST_PROTO_VERSION } = shared;

      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-claude-e2e-'));
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-claude-e2e-cwd-'));
      const host = new SessionHost({ stateDir });
      await host.start();
      const token = fs.readFileSync(path.join(stateDir, 'host-token'), 'utf8').trim();

      const sock = net.connect(host.socketPath);
      const decoder = new FrameDecoder();
      const ctrls: Record<string, unknown>[] = [];
      let screen = '';
      let sid = -1;
      sock.on('data', (chunk) => {
        for (const f of decoder.push(chunk)) {
          if (f.kind === 'ctrl') ctrls.push(f.json as Record<string, unknown>);
          else if (f.kind === 'out' && f.sid === sid) screen += f.data.toString('utf8');
        }
      });
      await new Promise<void>((res, rej) => {
        sock.once('connect', () => res());
        sock.once('error', rej);
      });

      cleanup = () => {
        try {
          sock.destroy();
        } catch {
          /* ignore */
        }
        host.stop();
        fs.rmSync(stateDir, { recursive: true, force: true });
        fs.rmSync(cwd, { recursive: true, force: true });
      };

      const send = (msg: unknown): void => void sock.write(FrameEncoder.ctrl(msg as never));

      // hello
      send({ t: 'hello', proto: HOST_PROTO_VERSION, token });
      await until(() => ctrls.find((m) => m['t'] === 'helloOk'), 5000, 'helloOk');

      // spawn claude --model sonnet (skip-permissions so a trust menu never
      // blocks idle detection in a throwaway cwd).
      const claudeBin = fs.existsSync(path.join(os.homedir(), '.local/bin/claude'))
        ? path.join(os.homedir(), '.local/bin/claude')
        : 'claude';
      send({
        t: 'spawn',
        reqId: 'r1',
        spec: {
          cmd: claudeBin,
          args: ['--model', 'sonnet', '--dangerously-skip-permissions'],
          cwd,
          cols: 100,
          rows: 34,
          env: {},
        },
      });
      const spawned = await until(
        () => ctrls.find((m) => m['t'] === 'spawned') as { sid?: number } | undefined,
        10000,
        'spawned',
      );
      sid = spawned.sid ?? -1;
      expect(sid).toBeGreaterThan(0);

      const inject = (bytes: Uint8Array): void =>
        void sock.write(FrameEncoder.input(sid, Buffer.from(bytes)));
      const driver = new ClaudeDriver(claudeKeymap, inject);

      // The accumulated buffer only grows, so detect on the TAIL (~ the current
      // frame): a stale "esc to interrupt" from a past turn must not read as busy.
      const tail = (): string => stripAnsi(screen).slice(-3000);

      // 1) wait for the first idle prompt.
      await until(
        () => (driver.detectPromptState(tail()).kind === 'idle' ? true : undefined),
        45000,
        'initial idle prompt',
      );

      // 2) send a trivial prompt.
      const before = screen.length;
      await driver.sendText({ text: 'Reply with exactly the single word: pong', submit: true });

      // 3) observe the busy (generating) state via the driver's own classifier.
      await until(
        () => (driver.detectPromptState(tail()).kind === 'busy' ? true : undefined),
        30000,
        'busy (generating)',
      );

      // 4) confirm the return to idle via OUTPUT QUIESCENCE. The PTY buffer is
      // append-only, so a spinner's braille never leaves the stripped scrollback
      // (overwrites don't delete prior bytes) — the honest observable that a turn
      // has ended is that output stops flowing.
      let lastLen = -1;
      let quietSince = Date.now();
      await until(() => {
        if (screen.length !== lastLen) {
          lastLen = screen.length;
          quietSince = Date.now();
          return undefined;
        }
        return Date.now() - quietSince > 2500 ? true : undefined;
      }, 45000, 'generation quiescence (return to idle)');

      expect(screen.length).toBeGreaterThan(before);
    },
    90000,
  );
});
