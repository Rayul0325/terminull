/**
 * Minimal test client for the paneld wire protocol: connects to the unix
 * socket, frames CTRL/IN messages, and buffers decoded frames + per-session
 * OUT bytes for assertion helpers. Test-only — the real client lands with the
 * panel-server milestone.
 */
import net from 'node:net';
import {
  FrameDecoder,
  FrameEncoder,
  HOST_PROTO_VERSION,
  type ClientControl,
  type DecodedFrame,
} from '@terminull/shared';

/** Poll `fn` until it returns non-undefined or `timeoutMs` elapses. */
export async function until<T>(
  fn: () => T | undefined,
  timeoutMs: number,
  what = 'condition',
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

interface OutChunk {
  seq: bigint;
  data: Buffer;
}

export class TestClient {
  readonly frames: DecodedFrame[] = [];
  /** OUT payloads per sid, in arrival order. */
  readonly outs = new Map<number, OutChunk[]>();
  closed = false;

  private constructor(private readonly socket: net.Socket) {}

  static connect(socketPath: string): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(socketPath);
      const client = new TestClient(socket);
      const decoder = new FrameDecoder();
      socket.on('connect', () => resolve(client));
      socket.on('error', (e) => {
        if (!client.closed) reject(e);
      });
      socket.on('close', () => {
        client.closed = true;
      });
      socket.on('data', (chunk) => {
        for (const frame of decoder.push(chunk)) {
          client.frames.push(frame);
          if (frame.kind === 'out') {
            const list = client.outs.get(frame.sid) ?? [];
            list.push({ seq: frame.seq, data: frame.data });
            client.outs.set(frame.sid, list);
          }
        }
      });
    });
  }

  /**
   * Connect with retries. A daemon that just started has a real bind→listen
   * window on unix sockets: the socket FILE exists after bind(2), but a
   * connect(2) landing before listen(2) is refused. Retrying absorbs it.
   */
  static async connectRetry(socketPath: string, timeoutMs = 5000): Promise<TestClient> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        return await TestClient.connect(socketPath);
      } catch (e) {
        if (Date.now() > deadline) throw e;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  }

  ctrl(msg: ClientControl): void {
    this.socket.write(FrameEncoder.ctrl(msg));
  }

  input(sid: number, data: Buffer | string): void {
    this.socket.write(
      FrameEncoder.input(sid, typeof data === 'string' ? Buffer.from(data) : data),
    );
  }

  /** hello + await helloOk (throws on error reply). */
  async hello(token: string, timeoutMs = 3000): Promise<Record<string, unknown>> {
    this.ctrl({ t: 'hello', proto: HOST_PROTO_VERSION, token });
    const reply = await this.waitCtrl((m) => m.t === 'helloOk' || m.t === 'error', timeoutMs);
    if (reply.t === 'error') throw new Error(`hello rejected: ${String(reply.msg)}`);
    return reply;
  }

  /** First buffered CTRL message matching `pred` (waits for arrival). */
  waitCtrl(
    pred: (msg: Record<string, unknown>) => boolean,
    timeoutMs = 3000,
    what = 'ctrl message',
  ): Promise<Record<string, unknown>> {
    let cursor = 0;
    return until(
      () => {
        for (; cursor < this.frames.length; cursor++) {
          const frame = this.frames[cursor];
          if (frame?.kind !== 'ctrl') continue;
          const msg = frame.json as Record<string, unknown>;
          if (pred(msg)) {
            cursor++;
            return msg;
          }
        }
        return undefined;
      },
      timeoutMs,
      what,
    );
  }

  /** All OUT bytes received so far for `sid`, concatenated in arrival order. */
  outBytes(sid: number): Buffer {
    return Buffer.concat((this.outs.get(sid) ?? []).map((c) => c.data));
  }

  /** Wait until the accumulated OUT bytes for `sid` contain `needle`. */
  async waitOutContains(sid: number, needle: string, timeoutMs = 5000): Promise<Buffer> {
    return until(
      () => {
        const bytes = this.outBytes(sid);
        return bytes.includes(needle) ? bytes : undefined;
      },
      timeoutMs,
      `OUT containing ${JSON.stringify(needle)}`,
    );
  }

  /** Wait for the socket to be closed by the peer. */
  waitClosed(timeoutMs = 3000): Promise<boolean> {
    return until(() => (this.closed ? true : undefined), timeoutMs, 'socket close');
  }

  close(): void {
    this.socket.destroy();
  }
}
