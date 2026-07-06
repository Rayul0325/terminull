/**
 * `paneld agent` relay tests — the SSH stand-in topology from m8-contract §4/§8
 * Track A: the relay child is ALWAYS a local `node dist/bin.js agent ...`
 * process over piped stdio (never a real ssh), the daemon is a test-tracked
 * child, and every state dir is a short mkdtemp under os.tmpdir().
 *
 * Covers: preamble-first stdout purity, hello token rewrite (panel sends ''),
 * spawn+IN/OUT byte round-trip through the relay, relay-terminated collect
 * against a FAKE tool home, relay death honesty (daemon + session survive,
 * fresh relay replays the ring via sinceSeq), daemon death honesty (new
 * bootId + zero sessions through a fresh relay — never fake continuity),
 * --no-spawn failure, --probe, and the daemon-spawning path.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AGENT_PREAMBLE, FrameDecoder, FrameEncoder, HOST_PROTO_VERSION } from '@terminull/shared';
import { runAgentRelay } from '../src/agent-relay';
import { SessionHost } from '../src/host';
import { AgentClient } from './agent-client';
import { until } from './client';

const pkgRoot = fileURLToPath(new URL('..', import.meta.url));
const binJs = path.join(pkgRoot, 'dist', 'bin.js');
const repoRoot = path.resolve(pkgRoot, '..', '..');

const dirs: string[] = [];
const procs: ChildProcess[] = [];
const agents: AgentClient[] = [];
const strayPids: number[] = [];

function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function startDaemon(stateDir: string): ChildProcess {
  const child = spawn(process.execPath, [binJs, 'start', '--state-dir', stateDir], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  procs.push(child);
  return child;
}

/**
 * Wait until a SPECIFIC daemon child is accepting: host.pid is written only
 * AFTER a successful bind (A2), so matching its content beats watching the
 * socket file (a SIGKILLed predecessor leaves a stale host.sock behind).
 */
async function waitDaemonReady(stateDir: string, daemon: ChildProcess): Promise<void> {
  const pidFile = path.join(stateDir, 'host.pid');
  await until(
    () => {
      try {
        return fs.readFileSync(pidFile, 'utf8').trim() === String(daemon.pid) ? true : undefined;
      } catch {
        return undefined;
      }
    },
    5000,
    `host.pid == ${daemon.pid}`,
  );
}

function agent(args: string[]): AgentClient {
  const a = new AgentClient(binJs, args);
  agents.push(a);
  return a;
}

/** Fake tool home: one live claude session (this process's pid) + one recent. */
function makeFakeHome(): string {
  const home = tmp('tn8-fh-');
  const sessions = path.join(home, '.claude', 'sessions');
  const project = path.join(home, '.claude', 'projects', '-tmp-proj');
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(
    path.join(sessions, `${process.pid}.json`),
    JSON.stringify({
      pid: process.pid, // the vitest worker: verifiably alive from the agent child
      sessionId: 'fake-live-1',
      cwd: '/tmp/proj',
      name: 'Fake live session',
      updatedAt: Date.now(),
    }),
  );
  fs.writeFileSync(path.join(project, 'fake-recent-1.jsonl'), '{}\n');
  return home;
}

beforeAll(() => {
  // These tests drive the BUILT bin; build it if this run came before tsc.
  if (!fs.existsSync(binJs)) {
    execFileSync(path.join(repoRoot, 'node_modules', '.bin', 'tsc'), ['-b'], { cwd: pkgRoot });
  }
});

afterEach(() => {
  for (const a of agents.splice(0)) a.kill();
  for (const p of procs.splice(0)) {
    if (p.exitCode === null && p.signalCode === null) p.kill('SIGTERM');
  }
  for (const pid of strayPids.splice(0)) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('paneld agent (spawned bin over piped stdio)', () => {
  it('--probe prints exactly the preamble and exits 0', async () => {
    const a = agent(['--probe']);
    const code = await a.waitExit();
    expect(code).toBe(0);
    expect(a.preambleSeen).toBe(true);
    expect(a.frames).toEqual([]); // nothing after the preamble
    expect(a.purityError).toBeNull();
  });

  it('--no-spawn with a dead socket exits non-zero with a clear stderr line, no preamble', async () => {
    const dir = tmp('tn8-ns-');
    const a = agent(['--state-dir', dir, '--no-spawn']);
    const code = await a.waitExit();
    expect(code).not.toBe(0);
    expect(a.preambleSeen).toBe(false); // stdout stayed empty — no fake handshake
    expect(a.stderrText).toContain('--no-spawn');
  });

  it('rejects an over-long socket path with the coded error before any handshake', async () => {
    const base = tmp('tn8-long-');
    const longDir = path.join(base, 'x'.repeat(110));
    const a = agent(['--state-dir', longDir, '--no-spawn']);
    const code = await a.waitExit();
    expect(code).not.toBe(0);
    expect(a.preambleSeen).toBe(false);
    expect(a.stderrText).toContain('sun_path');
  });

  it('full round-trip: rewrite+spawn+IN/OUT, collect vs fake home, relay death, daemon death honesty', async () => {
    const remoteDir = tmp('tn8-r-');
    const fakeHome = makeFakeHome();
    const daemon1 = startDaemon(remoteDir);
    await waitDaemonReady(remoteDir, daemon1);

    // --- relay 1: token-'' hello succeeds against the token-protected daemon ---
    const a1 = agent(['--state-dir', remoteDir, '--no-spawn', '--home', fakeHome]);
    await a1.waitPreamble();
    const hello1 = await a1.hello(''); // rewrite proven: daemon would reject ''
    const bootId = hello1.bootId as string;
    expect(hello1.sessions).toEqual([]);

    // --- byte round-trip through relay + daemon ---
    a1.ctrl({
      t: 'spawn',
      reqId: 'spawn-1',
      spec: {
        cmd: '/bin/cat',
        args: [],
        cwd: os.tmpdir(),
        env: {},
        cols: 80,
        rows: 24,
        label: 'relay-cat',
      },
    });
    const spawned = await a1.waitCtrl(
      (m) => m.t === 'spawned' && m.reqId === 'spawn-1',
      5000,
      'spawned',
    );
    const sid = spawned.sid as number;
    a1.input(sid, 'relay-roundtrip\n');
    await a1.waitOutContains(sid, 'relay-roundtrip');

    // --- relay-terminated collect against the FAKE home ---
    a1.ctrl({ t: 'collect', reqId: 'c1' });
    const collected = await a1.waitCtrl((m) => m.t === 'collected', 5000, 'collected');
    expect(collected.reqId).toBe('c1');
    expect(collected.supported).toBe(true);
    expect(collected.adapters).toEqual([
      { adapterId: 'claude', ok: true, sessions: 2 },
      { adapterId: 'codex', ok: true, sessions: 0 }, // absent .codex home: honest zero
    ]);
    const ids = new Map(
      (collected.sessions as Array<Record<string, unknown>>).map((s) => [s.id, s]),
    );
    expect(ids.get('fake-live-1')).toMatchObject({ tool: 'claude', live: true });
    expect(ids.get('fake-recent-1')).toMatchObject({ tool: 'claude', live: false });

    // --- stdout stayed byte-clean through all of the above ---
    expect(a1.purityError).toBeNull();

    // --- kill the relay: daemon and session must survive (sessions live remotely) ---
    a1.kill('SIGKILL');
    const a2 = agent(['--state-dir', remoteDir, '--no-spawn', '--home', fakeHome]);
    await a2.waitPreamble();
    const hello2 = await a2.hello('');
    expect(hello2.bootId).toBe(bootId); // same daemon — real continuity
    const advertised = hello2.sessions as Array<Record<string, unknown>>;
    expect(advertised.map((s) => s.sid)).toEqual([sid]);
    expect(advertised[0]).toMatchObject({ running: true });

    // --- reattach with sinceSeq:0 replays the pre-death ring bytes ---
    a2.ctrl({ t: 'attach', reqId: 'att-1', sid, sinceSeq: 0 });
    const attached = await a2.waitCtrl((m) => m.t === 'attached', 5000, 'attached');
    expect(attached.fromSeq).toBe(0);
    expect(attached.gap).toBe(false);
    await a2.waitOutContains(sid, 'relay-roundtrip'); // ring replay through relay 2
    a2.input(sid, 'second-pass\n'); // and the session is still interactive
    await a2.waitOutContains(sid, 'second-pass');
    expect(a2.purityError).toBeNull();

    // --- daemon death honesty THROUGH agent mode: restart must not fake continuity ---
    daemon1.kill('SIGKILL');
    await until(() => (a2.exitCode !== null ? true : undefined), 5000, 'relay exit');
    const daemon2 = startDaemon(remoteDir);
    await waitDaemonReady(remoteDir, daemon2);
    const a3 = agent(['--state-dir', remoteDir, '--no-spawn', '--home', fakeHome]);
    await a3.waitPreamble();
    const hello3 = await a3.hello('');
    expect(hello3.hostId).toBe(hello1.hostId); // stable machine identity...
    expect(hello3.bootId).not.toBe(bootId); // ...but a NEW boot...
    expect(hello3.sessions).toEqual([]); // ...and NO ghost sessions
    daemon2.kill('SIGTERM');
  }, 30_000);

  it('spawns the daemon itself when the socket is dead (and host.pid names it)', async () => {
    const dir = tmp('tn8-sp-');
    const a = agent(['--state-dir', dir]); // no --no-spawn: agent must boot the daemon
    await a.waitPreamble(10_000);
    const hello = await a.hello('');
    expect(typeof hello.bootId).toBe('string');

    // The detached daemon advertises itself via host.pid (A2) — track + reap it.
    const pidText = fs.readFileSync(path.join(dir, 'host.pid'), 'utf8').trim();
    const daemonPid = Number(pidText);
    expect(Number.isInteger(daemonPid)).toBe(true);
    expect(() => process.kill(daemonPid, 0)).not.toThrow(); // genuinely alive
    strayPids.push(daemonPid);
    expect(a.purityError).toBeNull();
  }, 20_000);
});

// ---------------------------------------------------------------------------
// In-process honest-degrade paths (injected stdio; no child, no collector)
// ---------------------------------------------------------------------------

/** Minimal in-process peer for runAgentRelay over PassThrough streams. */
class InProcPeer {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly ctrls: Array<Record<string, unknown>> = [];
  stderrText = '';
  stdoutBytes = 0;
  private head: Buffer = Buffer.alloc(0);
  private preambleSeen = false;
  private readonly decoder = new FrameDecoder();

  constructor() {
    this.stderr.on('data', (c: Buffer) => {
      this.stderrText += c.toString('utf8');
    });
    this.stdout.on('data', (c: Buffer) => {
      this.stdoutBytes += c.length;
      if (!this.preambleSeen) {
        this.head = Buffer.concat([this.head, c]);
        const nl = this.head.indexOf(0x0a);
        if (nl === -1) return;
        expect(this.head.subarray(0, nl).toString('utf8')).toBe(AGENT_PREAMBLE);
        this.preambleSeen = true;
        c = this.head.subarray(nl + 1);
        if (c.length === 0) return;
      }
      for (const frame of this.decoder.push(c)) {
        if (frame.kind === 'ctrl') this.ctrls.push(frame.json as Record<string, unknown>);
      }
    });
  }

  ctrl(msg: Record<string, unknown>): void {
    this.stdin.write(FrameEncoder.ctrl(msg as never));
  }

  waitCtrl(
    pred: (m: Record<string, unknown>) => boolean,
    what: string,
  ): Promise<Record<string, unknown>> {
    return until(() => this.ctrls.find(pred), 5000, what);
  }
}

describe('runAgentRelay honest degrades (in-process)', () => {
  let dir: string;
  let host: SessionHost;

  afterEach(() => {
    host?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function boot(collector?: Parameters<typeof runAgentRelay>[0]['collector']) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn8-ip-'));
    host = new SessionHost({ stateDir: dir });
    await host.start();
    const peer = new InProcPeer();
    const done = runAgentRelay({
      stateDir: dir,
      noSpawn: true,
      ...(collector ? { collector } : {}),
      stdin: peer.stdin,
      stdout: peer.stdout,
      stderr: peer.stderr,
    });
    return { peer, done };
  }

  it('collect without a collector answers supported:false collectors_unavailable', async () => {
    const { peer, done } = await boot();
    peer.ctrl({ t: 'hello', proto: HOST_PROTO_VERSION, token: '' });
    await peer.waitCtrl((m) => m.t === 'helloOk', 'helloOk'); // rewrite works in-process too
    peer.ctrl({ t: 'collect', reqId: 'c-1' });
    const collected = await peer.waitCtrl((m) => m.t === 'collected', 'collected');
    expect(collected).toEqual({
      t: 'collected',
      reqId: 'c-1',
      supported: false,
      reason: 'collectors_unavailable',
      adapters: [],
      sessions: [],
    });
    peer.stdin.end(); // clean peer close → exit 0
    expect(await done).toBe(0);
  });

  it('a throwing collector degrades to supported:false collector_failed', async () => {
    const { peer, done } = await boot(() => Promise.reject(new Error('disk on fire')));
    peer.ctrl({ t: 'hello', proto: HOST_PROTO_VERSION, token: '' });
    await peer.waitCtrl((m) => m.t === 'helloOk', 'helloOk');
    peer.ctrl({ t: 'collect', reqId: 'c-2' });
    const collected = await peer.waitCtrl((m) => m.t === 'collected', 'collected');
    expect(collected).toMatchObject({ supported: false, reason: 'collector_failed' });
    expect(peer.stderrText).toContain('disk on fire');
    peer.stdin.end();
    expect(await done).toBe(0);
  });

  it('a collector returning schema-invalid data degrades honestly (wire stays valid)', async () => {
    const { peer, done } = await boot(() =>
      // live must be boolean — an invalid session must never hit the wire
      Promise.resolve({
        supported: true,
        adapters: [],
        sessions: [{ id: 'x', tool: 'claude', live: 'maybe' }],
      } as never),
    );
    peer.ctrl({ t: 'hello', proto: HOST_PROTO_VERSION, token: '' });
    await peer.waitCtrl((m) => m.t === 'helloOk', 'helloOk');
    peer.ctrl({ t: 'collect', reqId: 'c-3' });
    const collected = await peer.waitCtrl((m) => m.t === 'collected', 'collected');
    expect(collected).toMatchObject({ supported: false, reason: 'collector_failed' });
    peer.stdin.end();
    expect(await done).toBe(0);
  });

  it('socket-path-too-long fails before the preamble (stdout stays empty)', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tn8-lg-'));
    dir = base; // reuse afterEach cleanup
    const peer = new InProcPeer();
    const code = await runAgentRelay({
      stateDir: path.join(base, 'y'.repeat(120)),
      noSpawn: true,
      stdin: peer.stdin,
      stdout: peer.stdout,
      stderr: peer.stderr,
    });
    expect(code).toBe(1);
    expect(peer.stdoutBytes).toBe(0);
    expect(peer.stderrText).toContain('sun_path');
  });
});
