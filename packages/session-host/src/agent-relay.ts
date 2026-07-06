/**
 * `paneld agent` — the remote-machine stdio relay (M8).
 *
 * Runs ON the remote machine (launched by `ssh <host> <agent-cmd>`, or by a
 * local `node bin.js agent ...` child in unit tests — never a real ssh there).
 * It bridges its OWN stdin/stdout to the machine-local paneld unix socket so
 * sessions live in the machine's daemon and survive relay/SSH drops.
 *
 * Behaviour (m8-contract.md §4):
 *
 *  1. Validate the socket path length (`assertSocketPathOk`) and ensure the
 *     local daemon is running: spawn it detached when the socket is dead,
 *     unless `noSpawn` (then exit non-zero with a clear stderr message).
 *  2. Print `AGENT_PREAMBLE + '\n'` to stdout, THEN speak binary frames only.
 *     All diagnostics go to stderr — stdout is preamble + frames, nothing else.
 *  3. stdin → socket: frame-aware (FrameSplitter). The first `hello` CTRL gets
 *     its token REWRITTEN to the daemon's real `host-token` (SSH already
 *     authenticated the peer; the placeholder token from the panel is ignored).
 *     `collect` CTRL frames are TERMINATED here (never forwarded): reply with
 *     `collected` — honest `{supported:false, reason:'collectors_unavailable'}`
 *     unless a collector module was provided.
 *  4. socket → stdout: frame-aware passthrough (FrameSplitter), so the relay's
 *     own `collected` replies interleave only at frame boundaries.
 *  5. Either side closing tears down the other; the daemon keeps running.
 *
 * The relay is deliberately STATELESS about identity: `helloOk` (hostId,
 * bootId, sessions) passes through from the daemon verbatim, so a relay
 * restart never fakes continuity — same daemon ⇒ same bootId, rebooted
 * daemon ⇒ new bootId and an empty session list, exactly as if the panel had
 * dialed the socket directly.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AGENT_PREAMBLE,
  assertSocketPathOk,
  CollectedSchema,
  FrameEncoder,
  FrameKind,
  FrameSplitter,
  FRAME_HEADER_BYTES,
  type Collected,
} from '@terminull/shared';

/** Options for {@link runAgentRelay} (wired from `paneld agent` argv). */
export interface AgentRelayOptions {
  /** paneld state dir on THIS machine (host.sock / host-token / host-id). */
  stateDir: string;
  /** Refuse to spawn a daemon when the socket is dead (unit-test topology). */
  noSpawn?: boolean;
  /**
   * Optional remote session collector. Absent ⇒ `collect` answers an honest
   * `{supported:false, reason:'collectors_unavailable'}` — never a fake [].
   */
  collector?: () => Promise<Omit<Collected, 't' | 'reqId'>>;
  /** Injectable stdio for tests (defaults to process.{stdin,stdout,stderr}). */
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

/** How long the relay waits for a just-spawned daemon's socket to accept. */
const DAEMON_WAIT_MS = 10_000;
const DAEMON_POLL_MS = 100;

/**
 * Encode an agent-vocabulary CTRL message. `collected` (and the rewritten
 * hello, which is structurally a plain hello) sit outside paneld's closed
 * Client/HostControl unions, but the frame body is just UTF-8 JSON — the cast
 * only widens the compile-time union, never the wire shape.
 */
function encodeAgentCtrl(msg: Record<string, unknown>): Buffer {
  return FrameEncoder.ctrl(msg as unknown as Parameters<(typeof FrameEncoder)['ctrl']>[0]);
}

/** One dial attempt; resolves a connected socket or rejects. */
function dial(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    socket.once('connect', () => {
      socket.removeAllListeners('error');
      resolve(socket);
    });
    socket.once('error', (e) => reject(e));
  });
}

/** Spawn `paneld start` detached, logging to `<stateDir>/paneld.log`. */
function spawnDaemon(stateDir: string): void {
  // dist/agent-relay.js sits next to dist/bin.js — same resolution the
  // enrolled launcher relies on. (Unit tests always pass noSpawn or exercise
  // this through the BUILT bin, so a src-tree run never reaches here.)
  const binJs = fileURLToPath(new URL('./bin.js', import.meta.url));
  if (!fs.existsSync(binJs)) {
    throw new Error(`paneld bin not found at ${binJs} (unbuilt package?)`);
  }
  // Route daemon output to a log file: a boot failure (e.g. the AF_UNIX
  // socket-path cap) must leave a breadcrumb, not die into stdio:'ignore'.
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const log = fs.openSync(path.join(stateDir, 'paneld.log'), 'a');
  try {
    const child = spawn(process.execPath, [binJs, 'start', '--state-dir', stateDir], {
      detached: true,
      stdio: ['ignore', log, log],
    });
    child.unref();
  } finally {
    fs.closeSync(log);
  }
}

/** Dial the daemon, spawning it once when dead (unless noSpawn). */
async function ensureDaemon(
  stateDir: string,
  socketPath: string,
  noSpawn: boolean,
): Promise<net.Socket> {
  try {
    return await dial(socketPath);
  } catch (e) {
    if (noSpawn) {
      throw new Error(
        `daemon socket ${socketPath} is not accepting connections ` +
          `(${e instanceof Error ? e.message : String(e)}) and --no-spawn is set`,
      );
    }
  }
  spawnDaemon(stateDir);
  const deadline = Date.now() + DAEMON_WAIT_MS;
  for (;;) {
    try {
      return await dial(socketPath);
    } catch (e) {
      if (Date.now() > deadline) {
        throw new Error(
          `daemon did not come up within ${DAEMON_WAIT_MS}ms ` +
            `(${e instanceof Error ? e.message : String(e)}); see ${path.join(stateDir, 'paneld.log')}`,
        );
      }
      await new Promise((r) => setTimeout(r, DAEMON_POLL_MS));
    }
  }
}

/** Run the relay until either side closes. Resolves with a process exit code. */
export async function runAgentRelay(opts: AgentRelayOptions): Promise<number> {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const log = (line: string): void => {
    stderr.write(`paneld agent: ${line}\n`);
  };

  // 1. Socket-path guard FIRST — the coded message beats a baffling EINVAL.
  const socketPath = path.join(opts.stateDir, 'host.sock');
  try {
    assertSocketPathOk(socketPath);
  } catch (e) {
    log(e instanceof Error ? e.message : String(e));
    return 1;
  }

  // 2. Ensure the daemon and read its real token (written before it binds,
  //    so a successful dial guarantees the file exists).
  let socket: net.Socket;
  try {
    socket = await ensureDaemon(opts.stateDir, socketPath, opts.noSpawn ?? false);
  } catch (e) {
    log(e instanceof Error ? e.message : String(e));
    return 1;
  }
  let token: string;
  try {
    token = fs.readFileSync(path.join(opts.stateDir, 'host-token'), 'utf8').trim();
  } catch (e) {
    log(`cannot read host-token: ${e instanceof Error ? e.message : String(e)}`);
    socket.destroy();
    return 1;
  }

  // 3. Preamble, then frames only. Diagnostics stay on stderr.
  stdout.write(AGENT_PREAMBLE + '\n');

  return new Promise<number>((resolve) => {
    let exitCode = 0;
    let finished = false;
    const finish = (code: number): void => {
      if (finished) return;
      finished = true;
      stdin.removeListener('data', onStdinData);
      socket.destroy();
      resolve(code);
    };

    const inSplit = new FrameSplitter();
    const outSplit = new FrameSplitter();
    let helloRewritten = false;

    const writeCollected = (reply: Collected): void => {
      // Whole-frame writes only: the socket→stdout path also emits whole
      // frames, so this can never land mid-frame.
      stdout.write(encodeAgentCtrl(reply as unknown as Record<string, unknown>));
    };

    const answerCollect = async (reqId: string): Promise<void> => {
      const honest = (reason: string): Collected => ({
        t: 'collected',
        reqId,
        supported: false,
        reason,
        adapters: [],
        sessions: [],
      });
      if (!opts.collector) {
        writeCollected(honest('collectors_unavailable'));
        return;
      }
      let body: Omit<Collected, 't' | 'reqId'>;
      try {
        body = await opts.collector();
      } catch (e) {
        log(`collector failed: ${e instanceof Error ? e.message : String(e)}`);
        writeCollected(honest('collector_failed'));
        return;
      }
      const reply = CollectedSchema.safeParse({ t: 'collected', reqId, ...body });
      if (!reply.success) {
        // A buggy collector must degrade honestly, not corrupt the wire.
        log(`collector produced an invalid reply: ${reply.error.message}`);
        writeCollected(honest('collector_failed'));
        return;
      }
      writeCollected(reply.data);
    };

    const handleClientFrame = (frame: Buffer): void => {
      if (frame.readUInt8(4) === FrameKind.Ctrl) {
        let json: unknown;
        try {
          json = JSON.parse(frame.subarray(FRAME_HEADER_BYTES).toString('utf8'));
        } catch {
          // Unparseable CTRL: forward raw and let the daemon reject it.
          socket.write(frame);
          return;
        }
        const msg = json as Record<string, unknown>;
        if (msg['t'] === 'hello' && !helloRewritten) {
          // SSH already authenticated this peer; swap the panel's placeholder
          // token for the daemon's real one. The panel never sees the token.
          helloRewritten = true;
          socket.write(encodeAgentCtrl({ ...msg, token }));
          return;
        }
        if (msg['t'] === 'collect') {
          // Relay-terminated: plain paneld's closed schema would reject it.
          void answerCollect(typeof msg['reqId'] === 'string' ? msg['reqId'] : '');
          return;
        }
      }
      socket.write(frame); // IN frames and all other CTRL: raw passthrough
    };

    const onStdinData = (chunk: Buffer): void => {
      let frames: Buffer[];
      try {
        frames = inSplit.push(chunk);
      } catch (e) {
        log(`unframeable stdin: ${e instanceof Error ? e.message : String(e)}`);
        finish(1);
        return;
      }
      for (const frame of frames) handleClientFrame(frame);
    };

    socket.on('data', (chunk: Buffer) => {
      let frames: Buffer[];
      try {
        frames = outSplit.push(chunk);
      } catch (e) {
        // The daemon never emits unframeable bytes; treat it as corruption.
        log(`unframeable daemon output: ${e instanceof Error ? e.message : String(e)}`);
        finish(1);
        return;
      }
      for (const frame of frames) stdout.write(frame);
    });
    socket.on('error', (e) => {
      log(`daemon socket error: ${e.message}`);
      exitCode = 1;
    });
    socket.on('close', () => finish(exitCode));

    stdin.on('data', onStdinData);
    stdin.on('end', () => socket.end()); // clean peer close → daemon close → exit 0
    stdin.on('error', () => finish(1));
    stdout.on('error', () => finish(1)); // e.g. EPIPE when the ssh parent died
  });
}
