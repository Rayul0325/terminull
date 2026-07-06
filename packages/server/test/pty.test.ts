/**
 * `/pty` WebSocket bridge tests against a real PTY (sh) through a real
 * SessionHost: read-write echo roundtrip, read-only input rejection, and the
 * user-credential requirement for rw mode.
 */
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { api, startStack, waitFor, type Stack } from './harness';

let stack: Stack;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await stack.close();
});

interface PtyProbe {
  ws: WebSocket;
  texts: any[];
  bytes: Buffer[];
  output(): string;
  closed: () => { code: number } | null;
}

function connectPty(sid: string, mode: 'rw' | 'ro', asUser: boolean): Promise<PtyProbe> {
  const ws = new WebSocket(`ws://127.0.0.1:${stack.port}/pty?sid=${sid}&mode=${mode}`, {
    headers: asUser ? { authorization: `Bearer ${stack.token}` } : {},
  });
  sockets.push(ws);
  const texts: any[] = [];
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
    bytes,
    output: () => Buffer.concat(bytes).toString('utf8'),
    closed: () => closeInfo,
  };
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(probe));
    ws.on('error', reject);
    // A pre-open rejection (e.g. 4403 close) still resolves via 'close'.
    ws.on('close', () => resolve(probe));
  });
}

async function spawnSh(): Promise<string> {
  const spawned = await api(stack, 'POST', '/api/sessions', {
    body: { adapterId: 'generic-pty', cwd: stack.stateDir, cmd: 'sh' },
    user: true,
  });
  expect(spawned.status).toBe(201);
  return spawned.body.sessionId;
}

describe('WS /pty', () => {
  it('rw: sends the attached frame, then echoes bytes end-to-end', async () => {
    stack = await startStack();
    const sid = await spawnSh();
    const probe = await connectPty(sid, 'rw', true);

    await waitFor(() => probe.texts.length >= 1);
    expect(probe.texts[0]).toMatchObject({ t: 'attached', readOnly: false });

    probe.ws.send(Buffer.from('echo PTY_ROUNDTRIP_42\n'), { binary: true });
    await waitFor(() => probe.output().includes('PTY_ROUNDTRIP_42'), 10000);
    expect(probe.output()).toContain('PTY_ROUNDTRIP_42');

    // Resize is accepted on a rw attachment (no error frame back).
    probe.ws.send(JSON.stringify({ t: 'resize', cols: 100, rows: 30 }));
    await new Promise((r) => setTimeout(r, 200));
    expect(probe.texts.filter((t) => t.t === 'error')).toEqual([]);
  }, 20000);

  it('ro: input and resize are rejected with read_only error frames', async () => {
    stack = await startStack();
    const sid = await spawnSh();
    const rw = await connectPty(sid, 'rw', true);
    await waitFor(() => rw.texts.length >= 1);

    const ro = await connectPty(sid, 'ro', false);
    await waitFor(() => ro.texts.length >= 1);
    expect(ro.texts[0]).toMatchObject({ t: 'attached', readOnly: true });

    ro.ws.send(Buffer.from('echo RO_MUST_NOT_RUN\n'), { binary: true });
    await waitFor(() => ro.texts.some((t) => t.t === 'error'));
    expect(ro.texts.some((t) => t.t === 'error' && t.code === 'read_only')).toBe(true);

    ro.ws.send(JSON.stringify({ t: 'resize', cols: 10, rows: 5 }));
    await waitFor(() => ro.texts.filter((t) => t.t === 'error').length >= 2);

    // The rejected input never reached the PTY (the rw viewer sees no echo).
    await new Promise((r) => setTimeout(r, 300));
    expect(rw.output()).not.toContain('RO_MUST_NOT_RUN');
    expect(ro.output()).not.toContain('RO_MUST_NOT_RUN');
  }, 20000);

  it('rw without a positive user credential is refused (4403)', async () => {
    stack = await startStack();
    const sid = await spawnSh();
    const probe = await connectPty(sid, 'rw', false);
    await waitFor(() => probe.closed() !== null);
    expect(probe.closed()).toEqual({ code: 4403 });
  }, 15000);

  it('unknown session closes with 4404', async () => {
    stack = await startStack();
    const probe = await connectPty('ghost', 'ro', false);
    await waitFor(() => probe.closed() !== null);
    expect(probe.closed()).toEqual({ code: 4404 });
  });
});
