/**
 * Integration tests against a real in-process SessionHost with real PTYs.
 *
 * NOTE: state dirs are created with mkdtemp under os.tmpdir() — macOS caps
 * AF_UNIX socket paths at 104 bytes, so long test paths would EINVAL at bind.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionHost } from '../src/host';
import { TestClient } from './client';

let dir: string;
let host: SessionHost;
let token: string;
const clients: TestClient[] = [];

async function connect(): Promise<TestClient> {
  const client = await TestClient.connect(host.socketPath);
  clients.push(client);
  return client;
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paneld-test-'));
  host = new SessionHost({ stateDir: dir });
  await host.start();
  token = fs.readFileSync(path.join(dir, 'host-token'), 'utf8').trim();
});

afterEach(() => {
  for (const c of clients.splice(0)) c.close();
  host.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('spawn / output / reattach across client restarts', () => {
  it(
    'a fresh client can list and resume a session its predecessor spawned',
    async () => {
      // --- client A: spawn and consume output up to marker-1 ---
      const a = await connect();
      await a.hello(token);
      a.ctrl({
        t: 'spawn',
        reqId: 'r-spawn',
        spec: {
          cmd: '/bin/sh',
          args: ['-c', 'printf marker-1; sleep 8; printf marker-2'],
          cwd: os.tmpdir(),
          env: {},
          cols: 80,
          rows: 24,
          label: 'reattach-proof',
        },
      });
      const spawned = await a.waitCtrl((m) => m.t === 'spawned', 3000, 'spawned');
      const sid = spawned.sid as number;
      expect(spawned.pid).toBeGreaterThan(0);

      await a.waitOutContains(sid, 'marker-1', 5000);
      // Spawner is auto-attached from byte 0, so its OUT seqs rise from 0.
      const chunks = a.outs.get(sid) ?? [];
      expect(chunks[0]?.seq).toBe(0n);
      for (let i = 1; i < chunks.length; i++) {
        expect(chunks[i]!.seq).toBeGreaterThan(chunks[i - 1]!.seq);
      }
      const seqAfterMarker1 = a.outBytes(sid).length;
      expect(seqAfterMarker1).toBeGreaterThanOrEqual('marker-1'.length);

      // --- client A disconnects entirely (panel-server "restart") ---
      a.close();

      // --- client B: fresh connection sees the session alive and resumes ---
      const b = await connect();
      const helloOk = await b.hello(token);
      const advertised = helloOk.sessions as Array<{ sid: number; running: boolean }>;
      expect(advertised.some((s) => s.sid === sid && s.running)).toBe(true);

      b.ctrl({ t: 'list', reqId: 'r-list' });
      const sessions = await b.waitCtrl((m) => m.t === 'sessions', 3000, 'sessions');
      const listed = (sessions.sessions as Array<{ sid: number; running: boolean }>).find(
        (s) => s.sid === sid,
      );
      expect(listed?.running).toBe(true);

      b.ctrl({ t: 'attach', reqId: 'r-attach', sid, sinceSeq: seqAfterMarker1 });
      const attached = await b.waitCtrl((m) => m.t === 'attached', 3000, 'attached');
      expect(attached.gap).toBe(false);
      expect(attached.fromSeq).toBe(seqAfterMarker1);

      const bytes = await b.waitOutContains(sid, 'marker-2', 12_000);
      expect(bytes.includes('marker-1')).toBe(false); // resumed AFTER marker-1
    },
    20_000,
  );
});

describe('multi-viewer fanout and read-only enforcement', () => {
  it(
    'two attachments see identical bytes; readOnly IN/resize are rejected',
    async () => {
      const a = await connect();
      await a.hello(token);
      a.ctrl({
        t: 'spawn',
        reqId: 'r-spawn',
        spec: { cmd: '/bin/cat', args: [], cwd: os.tmpdir(), env: {}, cols: 80, rows: 24 },
      });
      const spawned = await a.waitCtrl((m) => m.t === 'spawned', 3000, 'spawned');
      const sid = spawned.sid as number;

      const b = await connect();
      await b.hello(token);
      b.ctrl({ t: 'attach', reqId: 'r-attach', sid, sinceSeq: 0, readOnly: true });
      const attached = await b.waitCtrl((m) => m.t === 'attached', 3000, 'attached');
      expect(attached.gap).toBe(false);

      a.input(sid, 'hello-viewers\r');
      await a.waitOutContains(sid, 'hello-viewers', 5000);
      await b.waitOutContains(sid, 'hello-viewers', 5000);
      expect(Buffer.compare(a.outBytes(sid), b.outBytes(sid))).toBe(0);

      // read-only IN is rejected with an error frame and produces no output
      b.input(sid, 'forbidden-write\r');
      const inErr = await b.waitCtrl(
        (m) => m.t === 'error' && m.sid === sid,
        3000,
        'READ_ONLY error for IN',
      );
      expect(inErr.code).toBe('READ_ONLY');

      // read-only resize is rejected too (latest-active-WRITER wins policy)
      b.ctrl({ t: 'resize', sid, cols: 120, rows: 40 });
      const rsErr = await b.waitCtrl(
        (m) =>
          m.t === 'error' &&
          m.sid === sid &&
          m.code === 'READ_ONLY' &&
          String(m.msg).includes('resize'),
        3000,
        'READ_ONLY error for resize',
      );
      expect(rsErr.code).toBe('READ_ONLY');
      expect(a.outBytes(sid).includes('forbidden-write')).toBe(false);

      // the writer CAN resize
      a.ctrl({ t: 'resize', sid, cols: 100, rows: 30 });
      a.ctrl({ t: 'list', reqId: 'r-list2' });
      const sessions = await a.waitCtrl((m) => m.t === 'sessions', 3000, 'sessions');
      const summary = (
        sessions.sessions as Array<{ sid: number; cols: number; rows: number }>
      ).find((s) => s.sid === sid);
      expect(summary).toMatchObject({ cols: 100, rows: 30 });

      // kill: every authed client hears the exit
      a.ctrl({ t: 'kill', sid, signal: 'SIGTERM' });
      const exitA = await a.waitCtrl((m) => m.t === 'exit' && m.sid === sid, 5000, 'exit at A');
      await b.waitCtrl((m) => m.t === 'exit' && m.sid === sid, 5000, 'exit at B');
      expect(typeof exitA.code === 'number' || exitA.code === null).toBe(true);
    },
    20_000,
  );
});

describe('auth and file modes', () => {
  it('rejects a wrong token with an AUTH error and closes the connection', async () => {
    const c = await connect();
    c.ctrl({ t: 'hello', proto: 1, token: 'definitely-wrong' });
    const err = await c.waitCtrl((m) => m.t === 'error', 3000, 'auth error');
    expect(err.code).toBe('AUTH');
    await c.waitClosed();
  });

  it('rejects any pre-hello message and closes the connection', async () => {
    const c = await connect();
    c.ctrl({ t: 'list', reqId: 'r-early' });
    const err = await c.waitCtrl((m) => m.t === 'error', 3000, 'pre-hello error');
    expect(err.code).toBe('AUTH');
    await c.waitClosed();
  });

  it('creates stateDir 0700 and socket/token 0600', () => {
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(host.socketPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(dir, 'host-token')).mode & 0o777).toBe(0o600);
  });
});
