/**
 * Frame transports — the Duplex-stream seam under the paneld frame codec (M8).
 *
 * The codec (FrameEncoder/FrameDecoder in @terminull/shared) is stream-
 * agnostic; a transport just supplies connected byte streams. Two kinds:
 *
 *  - {@link UnixSocketTransport}: today's local daemon socket.
 *  - {@link StdioProcessTransport}: a spawned child's stdio — the SSH relay
 *    (`ssh <host> <remote-agent-cmd>`, lowered via `sshSpecToStdio`) and its
 *    unit-test stand-in (`node <paneld bin> agent --state-dir <tmp>`). No new
 *    listening ports, ever: SSH is both the pipe and the authentication.
 *
 * Every `connect()` yields a FRESH isolated stream, so the daemon's
 * per-connection semantics (hello auth, readOnly, replay) apply to remote
 * links unchanged — a machine's control link is one stream, and each PTY
 * attachment is another.
 *
 * Stdio streams begin with the agent preamble line (`AGENT_PREAMBLE`): remote
 * shells may print profile/MOTD noise ahead of the agent, so bytes are
 * discarded until that exact line and only the remainder is framed. Failure to
 * see the preamble within `AGENT_PREAMBLE_MAX_SCAN` bytes (or before the child
 * exits / the dial timeout fires) rejects with a coded error — never a hang.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import net from 'node:net';
import {
  AGENT_PREAMBLE,
  AGENT_PREAMBLE_MAX_SCAN,
  assertSocketPathOk,
  sshSpecToStdio,
  type TransportSpec,
} from '@terminull/shared';

/** A connected byte stream carrying frames. */
export interface FrameStream {
  write(chunk: Buffer): void;
  /** Register the data sink. Chunks arriving earlier are queued, not lost. */
  onData(fn: (chunk: Buffer) => void): void;
  /** Fired exactly once when the stream dies (either side, any reason). */
  onClose(fn: () => void): void;
  close(): void;
  /** OS pid of the backing child for process streams (gate-oracle test hook). */
  readonly childPid?: number;
}

/** A dialer. Every {@link connect} yields a fresh isolated stream. */
export interface FrameTransport {
  readonly kind: 'unix' | 'stdio';
  connect(): Promise<FrameStream>;
}

/** Thrown when a transport dial fails; `code` is machine-readable. */
export class TransportDialError extends Error {
  constructor(
    readonly code:
      'spawn_failed' | 'agent_exited' | 'agent_preamble_missing' | 'dial_timeout' | 'socket_error',
    message: string,
  ) {
    super(message);
    this.name = 'TransportDialError';
  }
}

interface StdioTransportOptions {
  /** Dial timeout (spawn → preamble seen). Default 15s. */
  connectTimeoutMs?: number;
  /** Diagnostic sink for the child's stderr (server logs it, masked). */
  onStderr?: (chunk: string) => void;
}

/** Base stream with a queue-until-first-listener data path. */
abstract class QueueingStream implements FrameStream {
  private dataFn: ((chunk: Buffer) => void) | null = null;
  private queued: Buffer[] = [];
  private readonly closeFns: (() => void)[] = [];
  private closedFired = false;

  abstract write(chunk: Buffer): void;
  abstract close(): void;

  protected pushData(chunk: Buffer): void {
    if (chunk.length === 0) return;
    if (this.dataFn) this.dataFn(chunk);
    else this.queued.push(chunk);
  }

  protected fireClose(): void {
    if (this.closedFired) return;
    this.closedFired = true;
    for (const fn of this.closeFns) fn();
  }

  onData(fn: (chunk: Buffer) => void): void {
    this.dataFn = fn;
    const backlog = this.queued;
    this.queued = [];
    for (const chunk of backlog) fn(chunk);
  }

  onClose(fn: () => void): void {
    if (this.closedFired) fn();
    else this.closeFns.push(fn);
  }
}

class SocketStream extends QueueingStream {
  constructor(private readonly socket: net.Socket) {
    super();
    socket.on('data', (chunk: Buffer) => this.pushData(chunk));
    socket.on('close', () => this.fireClose());
    socket.on('error', () => socket.destroy());
  }

  write(chunk: Buffer): void {
    if (!this.socket.destroyed && this.socket.writable) this.socket.write(chunk);
  }

  close(): void {
    this.socket.destroy();
  }
}

/** Dial the local paneld unix socket (path length validated first). */
export class UnixSocketTransport implements FrameTransport {
  readonly kind = 'unix';

  constructor(private readonly socketPath: string) {}

  connect(): Promise<FrameStream> {
    assertSocketPathOk(this.socketPath);
    return new Promise((resolve, reject) => {
      const socket = net.connect(this.socketPath);
      const onError = (e: Error): void => {
        socket.destroy();
        reject(new TransportDialError('socket_error', e.message));
      };
      socket.once('error', onError);
      socket.once('connect', () => {
        socket.removeListener('error', onError);
        resolve(new SocketStream(socket));
      });
    });
  }
}

class ProcessStream extends QueueingStream {
  readonly childPid: number;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    /** Bytes that followed the preamble in the same chunk. */
    remainder: Buffer,
  ) {
    super();
    this.childPid = child.pid ?? -1;
    if (remainder.length > 0) this.pushData(remainder);
    child.stdout.on('data', (chunk: Buffer) => this.pushData(chunk));
    child.once('close', () => this.fireClose());
    // A dead child makes stdin writes EPIPE; swallow instead of crashing.
    child.stdin.on('error', () => {});
  }

  write(chunk: Buffer): void {
    if (this.child.exitCode === null && !this.child.stdin.destroyed) {
      this.child.stdin.write(chunk);
    }
  }

  close(): void {
    this.child.kill('SIGTERM');
  }
}

/**
 * Spawn a child (no shell) and frame over its stdio after the preamble line.
 * The preamble must start a line; anything before it is discarded as shell
 * noise, anything after it is frame bytes.
 */
export class StdioProcessTransport implements FrameTransport {
  readonly kind = 'stdio';

  constructor(
    private readonly cmd: string,
    private readonly args: string[],
    private readonly opts: StdioTransportOptions = {},
  ) {}

  connect(): Promise<FrameStream> {
    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(this.cmd, this.args, { stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e) {
        reject(new TransportDialError('spawn_failed', e instanceof Error ? e.message : String(e)));
        return;
      }
      const marker = Buffer.from(`${AGENT_PREAMBLE}\n`, 'utf8');
      let scanned: Buffer = Buffer.alloc(0);
      let stderrTail = '';
      let settled = false;

      let timer: NodeJS.Timeout | null = null;
      const bail = (
        code: ConstructorParameters<typeof TransportDialError>[0],
        msg: string,
      ): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        child.kill('SIGTERM');
        const detail = stderrTail.trim().length > 0 ? `${msg}: ${stderrTail.trim()}` : msg;
        reject(new TransportDialError(code, detail));
      };
      timer = setTimeout(
        () => bail('dial_timeout', 'timed out waiting for agent preamble'),
        this.opts.connectTimeoutMs ?? 15_000,
      );

      child.once('error', (e) => bail('spawn_failed', e.message));
      child.stderr.on('data', (chunk: Buffer) => {
        // Keep a bounded tail for diagnostics; full stream goes to onStderr.
        stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4096);
        this.opts.onStderr?.(chunk.toString('utf8'));
      });
      child.once('close', (exitCode) => {
        bail('agent_exited', `agent exited (code ${exitCode ?? 'null'}) before preamble`);
      });

      const onStdout = (chunk: Buffer): void => {
        if (settled) return;
        scanned = scanned.length === 0 ? chunk : Buffer.concat([scanned, chunk]);
        const idx = scanned.indexOf(marker);
        const atLineStart = idx === 0 || (idx > 0 && scanned[idx - 1] === 0x0a);
        if (idx !== -1 && atLineStart) {
          settled = true;
          if (timer) clearTimeout(timer);
          child.stdout.removeListener('data', onStdout);
          const remainder = Buffer.from(scanned.subarray(idx + marker.length));
          resolve(new ProcessStream(child, remainder));
          return;
        }
        if (scanned.length > AGENT_PREAMBLE_MAX_SCAN) {
          bail('agent_preamble_missing', `no preamble in first ${AGENT_PREAMBLE_MAX_SCAN} bytes`);
        }
      };
      child.stdout.on('data', onStdout);
    });
  }
}

/** Build the transport for a machine's spec (ssh lowers to a stdio spawn). */
export function transportForSpec(
  spec: TransportSpec,
  opts: StdioTransportOptions = {},
): FrameTransport {
  const stdio = spec.kind === 'ssh' ? sshSpecToStdio(spec) : spec;
  return new StdioProcessTransport(stdio.cmd, stdio.args, opts);
}
