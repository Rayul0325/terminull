/**
 * Empirical probe: what permission modes does Shift+Tab actually cycle through
 * on the installed Claude Code? The parity survey (§C) flagged this as UNVERIFIED
 * for 2.1.201 ("new `auto` mode may have entered the cycle"), so we settle it by
 * driving a real session rather than guessing.
 *
 * Env-gated exactly like `e2e.test.ts` (skipped without a claude binary/auth):
 *   TERMINULL_E2E_CLAUDE=1 pnpm --filter @terminull/adapter-claude test shifttab
 * Spawns `claude --model sonnet --dangerously-skip-permissions` in a throwaway
 * cwd, reaches idle, then presses Shift+Tab (with the driver's Right-prime quirk)
 * up to 7 times, capturing the mode indicator after each press. The observed
 * cycle is printed for the maintainer to fold into SHIFT_TAB_CYCLE; the assertion
 * is intentionally loose (a real cycle of 2..6 recognized modes) so it documents
 * rather than over-pins.
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

/** Heuristic classification of the permission-mode badge in a screen tail. */
function modeBadge(tail: string): string {
  const t = tail.toLowerCase();
  if (/plan mode/.test(t)) return 'plan';
  if (/accept edits on|accept-edits on|auto-accept edits on/.test(t)) return 'acceptEdits';
  if (/bypass/.test(t)) return 'bypassPermissions';
  if (/\bmanual\b/.test(t)) return 'manual';
  if (/\bauto\b/.test(t) && !/auto-accept edits off/.test(t)) return 'auto';
  return 'default';
}

async function until<T>(fn: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out (${timeoutMs}ms) waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('ShiftTab permission-mode cycle probe (env-gated)', () => {
  let cleanup: (() => void) | null = null;
  afterAll(() => cleanup?.());

  it.skipIf(!RUN)(
    'captures the live Shift+Tab-reachable cycle on 2.1.201',
    async () => {
      const { SessionHost } = await import('@terminull/session-host');
      const { FrameEncoder, FrameDecoder, HOST_PROTO_VERSION } = await import('@terminull/shared');

      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-claude-btab-'));
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-claude-btab-cwd-'));
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
      send({ t: 'hello', proto: HOST_PROTO_VERSION, token });
      await until(() => ctrls.find((m) => m['t'] === 'helloOk'), 5000, 'helloOk');

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
      const tail = (): string => stripAnsi(screen).slice(-1500);

      await until(
        () => (driver.detectPromptState(tail()).kind === 'idle' ? true : undefined),
        45000,
        'initial idle prompt',
      );

      // Press Shift+Tab 8×. Classify only the DELTA output each press produces
      // (the append-only PTY buffer means stale scrollback would otherwise keep
      // matching an earlier mode's badge). Capture the raw footer line too, as
      // ground truth for whatever badge strings 2.1.201 actually prints.
      const observed: string[] = [];
      const rawFooters: string[] = [];
      let prevLen = screen.length;
      for (let i = 0; i < 8; i++) {
        await driver.sendKey('ShiftTab');
        await sleep(750); // let the footer repaint
        const delta = stripAnsi(screen.slice(prevLen));
        prevLen = screen.length;
        observed.push(modeBadge(delta));
        const footer =
          delta
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
            .reverse()
            .find((l) => /mode|edits|bypass|manual|\bauto\b|shift\s*\+?\s*tab/i.test(l)) ?? '';
        rawFooters.push(footer.slice(0, 80));
      }

      // Fold consecutive duplicates → the raw transition order; the distinct set
      // (in first-seen order) is the reachable cycle.
      const distinct: string[] = [];
      for (const b of observed) if (!distinct.includes(b)) distinct.push(b);

      console.log('[shifttab-probe] observed sequence:', observed.join(' → '));
      console.log('[shifttab-probe] reachable cycle (first-seen order):', distinct.join(', '));
      rawFooters.forEach((f, i) =>
        console.log(`[shifttab-probe] press ${i + 1} footer: ${JSON.stringify(f)}`),
      );

      const KNOWN = new Set([
        'default',
        'plan',
        'acceptEdits',
        'bypassPermissions',
        'auto',
        'manual',
      ]);
      expect(distinct.every((m) => KNOWN.has(m))).toBe(true);
      expect(distinct.length).toBeGreaterThanOrEqual(2);
      expect(distinct.length).toBeLessThanOrEqual(6);
    },
    120000,
  );
});
