/**
 * Test client for `paneld agent` children: spawns `node dist/bin.js agent ...`
 * with piped stdio and speaks the frame protocol over it. Mirrors
 * {@link TestClient} (unix-socket flavour) but additionally enforces STDOUT
 * PURITY: the very first bytes must be `AGENT_PREAMBLE\n` and every byte after
 * it must decode as frames — any stray print fails the owning test.
 *
 * Test-only. Never spawns ssh; the child is always a local node process.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  AGENT_PREAMBLE,
  FrameDecoder,
  FrameEncoder,
  HOST_PROTO_VERSION,
  type ClientControl,
  type DecodedFrame,
} from '@terminull/shared';
import { until } from './client';

interface OutChunk {
  seq: bigint;
  data: Buffer;
}

export class AgentClient {
  readonly frames: DecodedFrame[] = [];
  readonly outs = new Map<number, OutChunk[]>();
  readonly child: ChildProcessWithoutNullStreams;
  stderrText = '';
  exitCode: number | null = null;
  exitSignal: NodeJS.Signals | null = null;
  /** Set when stdout violated purity (noise before preamble / unframeable). */
  purityError: string | null = null;
  preambleSeen = false;

  private head: Buffer = Buffer.alloc(0);
  private readonly decoder = new FrameDecoder();

  constructor(binJs: string, args: string[]) {
    this.child = spawn(process.execPath, [binJs, 'agent', ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stderr.on('data', (c: Buffer) => {
      this.stderrText += c.toString('utf8');
    });
    this.child.on('exit', (code, signal) => {
      this.exitCode = code;
      this.exitSignal = signal;
    });
    this.child.stdout.on('data', (c: Buffer) => this.onStdout(c));
  }

  private onStdout(chunk: Buffer): void {
    if (this.purityError) return;
    if (!this.preambleSeen) {
      this.head = Buffer.concat([this.head, chunk]);
      const nl = this.head.indexOf(0x0a);
      if (nl === -1) {
        // The preamble line is short; anything longer without a newline is noise.
        if (this.head.length > AGENT_PREAMBLE.length + 1) {
          this.purityError = `no preamble line in first ${this.head.length} bytes`;
        }
        return;
      }
      const line = this.head.subarray(0, nl).toString('utf8');
      if (line !== AGENT_PREAMBLE) {
        // Purity: OUR agent must never print anything before the preamble
        // (the discard-noise tolerance exists for remote shells, not for us).
        this.purityError = `stdout began with ${JSON.stringify(line)}, not the preamble`;
        return;
      }
      this.preambleSeen = true;
      chunk = this.head.subarray(nl + 1);
      this.head = Buffer.alloc(0);
      if (chunk.length === 0) return;
    }
    try {
      for (const frame of this.decoder.push(chunk)) {
        this.frames.push(frame);
        if (frame.kind === 'out') {
          const list = this.outs.get(frame.sid) ?? [];
          list.push({ seq: frame.seq, data: frame.data });
          this.outs.set(frame.sid, list);
        }
      }
    } catch (e) {
      this.purityError = `unframeable stdout: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  waitPreamble(timeoutMs = 5000): Promise<boolean> {
    return until(
      () => {
        if (this.purityError) throw new Error(this.purityError);
        return this.preambleSeen ? true : undefined;
      },
      timeoutMs,
      'agent preamble',
    );
  }

  ctrl(msg: ClientControl | Record<string, unknown>): void {
    this.child.stdin.write(FrameEncoder.ctrl(msg as ClientControl));
  }

  input(sid: number, data: Buffer | string): void {
    this.child.stdin.write(
      FrameEncoder.input(sid, typeof data === 'string' ? Buffer.from(data) : data),
    );
  }

  /** hello + await helloOk (throws on error reply). */
  async hello(token: string, timeoutMs = 5000): Promise<Record<string, unknown>> {
    this.ctrl({ t: 'hello', proto: HOST_PROTO_VERSION, token });
    const reply = await this.waitCtrl((m) => m.t === 'helloOk' || m.t === 'error', timeoutMs);
    if (reply.t === 'error') throw new Error(`hello rejected: ${String(reply.msg)}`);
    return reply;
  }

  waitCtrl(
    pred: (msg: Record<string, unknown>) => boolean,
    timeoutMs = 5000,
    what = 'ctrl message',
  ): Promise<Record<string, unknown>> {
    let cursor = 0;
    return until(
      () => {
        if (this.purityError) throw new Error(this.purityError);
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

  outBytes(sid: number): Buffer {
    return Buffer.concat((this.outs.get(sid) ?? []).map((c) => c.data));
  }

  waitOutContains(sid: number, needle: string, timeoutMs = 5000): Promise<Buffer> {
    return until(
      () => {
        if (this.purityError) throw new Error(this.purityError);
        const bytes = this.outBytes(sid);
        return bytes.includes(needle) ? bytes : undefined;
      },
      timeoutMs,
      `OUT containing ${JSON.stringify(needle)}`,
    );
  }

  waitExit(timeoutMs = 5000): Promise<number> {
    return until(
      () => (this.exitCode !== null ? this.exitCode : undefined),
      timeoutMs,
      'agent exit',
    );
  }

  kill(signal: NodeJS.Signals = 'SIGKILL'): void {
    this.child.kill(signal);
  }
}
