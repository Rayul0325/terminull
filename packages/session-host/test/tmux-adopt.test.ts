/**
 * tmux adoption: wrap an external tmux session as an owned:false session and
 * drive it with tmux.sendText (which must clear any half-typed draft with C-u
 * before the literal text — the control-tower draft-clear quirk).
 *
 * Honestly skipped when no tmux binary is resolvable (e.g. a bare CI runner):
 * the guard is about robustness, not about assuming tmux is absent.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionHost } from '../src/host';
import { capturePane, resolveTmuxBin, sendText } from '../src/tmux';
import { TestClient, until } from './client';

const tmuxBin = resolveTmuxBin();

let dir: string | undefined;
let host: SessionHost | undefined;
let client: TestClient | undefined;
let tmuxSession: string | undefined;

afterEach(() => {
  client?.close();
  host?.stop();
  if (tmuxBin && tmuxSession) {
    try {
      execFileSync(tmuxBin, ['kill-session', '-t', tmuxSession]);
    } catch {
      /* already gone */
    }
  }
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = host = client = tmuxSession = undefined;
});

describe.skipIf(!tmuxBin)('tmux adoption (skipped when tmux binary is absent)', () => {
  it(
    'adopts an external tmux session (owned:false) and sendText reaches its pane',
    async () => {
      const bin = tmuxBin!;
      tmuxSession = `tnl-test-${crypto.randomBytes(4).toString('hex')}`;
      execFileSync(bin, ['new-session', '-d', '-s', tmuxSession, 'cat']);

      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paneld-tmux-'));
      host = new SessionHost({ stateDir: dir });
      await host.start();
      const token = fs.readFileSync(path.join(dir, 'host-token'), 'utf8').trim();

      client = await TestClient.connect(host.socketPath);
      await client.hello(token);

      client.ctrl({ t: 'adoptTmux', reqId: 'r-adopt', target: tmuxSession });
      const spawned = await client.waitCtrl(
        (m) => m.t === 'spawned' || m.t === 'error',
        5000,
        'adopt reply',
      );
      expect(spawned.t).toBe('spawned');
      const sid = spawned.sid as number;

      client.ctrl({ t: 'list', reqId: 'r-list' });
      const sessions = await client.waitCtrl((m) => m.t === 'sessions', 3000, 'sessions');
      const summary = (
        sessions.sessions as Array<{ sid: number; owned: boolean; running: boolean }>
      ).find((s) => s.sid === sid);
      expect(summary?.owned).toBe(false); // adopted, not ours
      expect(summary?.running).toBe(true);

      // Drive the adopted session via send-keys (C-u draft-clear + literal + Enter).
      await sendText(bin, tmuxSession, 'hello-adopt');
      const pane = await until(
        () => {
          let text = '';
          try {
            text = execFileSync(bin, ['capture-pane', '-t', tmuxSession!, '-p'], {
              encoding: 'utf8',
            });
          } catch {
            return undefined;
          }
          return text.includes('hello-adopt') ? text : undefined;
        },
        5000,
        'pane to show hello-adopt',
      );
      expect(pane).toContain('hello-adopt');

      // The adopted pty (tmux attach) also fans its output out to attachments.
      await client.waitOutContains(sid, 'hello-adopt', 5000);

      // capturePane helper agrees with the raw invocation above.
      expect(await capturePane(bin, tmuxSession)).toContain('hello-adopt');
    },
    15_000,
  );
});

describe.runIf(!tmuxBin)('tmux adoption without tmux', () => {
  it('reports why the adoption suite was skipped', () => {
    console.log('tmux binary not found (~/.local/bin/tmux and PATH) — adoption tests skipped');
    expect(tmuxBin).toBeNull();
  });
});
