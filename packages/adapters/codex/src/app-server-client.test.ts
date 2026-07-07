/**
 * Codex app-server client tests. A fake `codex app-server` child process drives
 * the newline JSON-RPC handshake so we can assert the initialize → thread/resume
 * → turn/start sequence and the honest 'unsupported' failure isolation — without
 * spawning a real codex.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { injectDirective } from './app-server-client';

/** Per-method reply behaviour for the fake app-server. */
interface FakeBehaviour {
  resumeError?: boolean;
  turnError?: boolean;
  spawnError?: boolean;
}

interface FakeHandle {
  requests: Array<{ method: string; params: unknown }>;
  spawn: (bin: string, args: string[]) => never;
}

function makeFake(behaviour: FakeBehaviour = {}): FakeHandle {
  const requests: Array<{ method: string; params: unknown }> = [];
  const spawn = (): never => {
    const stdout = new EventEmitter() as EventEmitter & { setEncoding: (e: string) => void };
    stdout.setEncoding = () => {};
    const stderr = new EventEmitter();
    const proc = new EventEmitter() as unknown as {
      stdin: { write: (s: string) => void; end: () => void };
      stdout: typeof stdout;
      stderr: EventEmitter;
      kill: () => void;
      on: (ev: string, cb: (...a: unknown[]) => void) => void;
    };
    proc.stdout = stdout;
    proc.stderr = stderr;
    proc.kill = () => {};

    if (behaviour.spawnError) {
      // Surface the child error asynchronously, like a real failed spawn.
      queueMicrotask(() => (proc as unknown as EventEmitter).emit('error', new Error('ENOENT')));
    }

    const reply = (id: number, ok: boolean): void => {
      const msg = ok
        ? { id, result: { ok: true } }
        : { id, error: { code: -32000, message: 'no such thread' } };
      queueMicrotask(() => stdout.emit('data', `${JSON.stringify(msg)}\n`));
    };

    proc.stdin = {
      write: (s: string) => {
        if (behaviour.spawnError) return; // dead process: never replies
        for (const line of s.split('\n')) {
          const t = line.trim();
          if (!t) continue;
          const req = JSON.parse(t) as { id: number; method: string; params: unknown };
          requests.push({ method: req.method, params: req.params });
          if (req.method === 'initialize') reply(req.id, true);
          else if (req.method === 'thread/resume') reply(req.id, !behaviour.resumeError);
          else if (req.method === 'turn/start') reply(req.id, !behaviour.turnError);
          else reply(req.id, true);
        }
      },
      end: () => {},
    };
    return proc as never;
  };
  return { requests, spawn };
}

describe('injectDirective (codex app-server)', () => {
  it('delivers: initialize → thread/resume → turn/start by the same threadId', async () => {
    const fake = makeFake();
    const result = await injectDirective('thread-abc', 'do the thing', {
      codexBin: '/fake/codex',
      spawn: fake.spawn,
    });
    expect(result).toBe('delivered');
    // The sequence and the id/text used for turn/start.
    expect(fake.requests.map((r) => r.method)).toEqual([
      'initialize',
      'thread/resume',
      'turn/start',
    ]);
    expect(fake.requests[1]!.params).toMatchObject({ threadId: 'thread-abc' });
    expect(fake.requests[2]!.params).toMatchObject({
      threadId: 'thread-abc',
      input: [{ type: 'text', text: 'do the thing', text_elements: [] }],
    });
  });

  it('unsupported (honest) when the thread is unknown — never sends turn/start', async () => {
    const fake = makeFake({ resumeError: true });
    const result = await injectDirective('missing', 'x', {
      codexBin: '/fake/codex',
      spawn: fake.spawn,
    });
    expect(result).toBe('unsupported');
    expect(fake.requests.some((r) => r.method === 'turn/start')).toBe(false);
  });

  it('unsupported when turn/start is rejected', async () => {
    const fake = makeFake({ turnError: true });
    const result = await injectDirective('t', 'x', { codexBin: '/fake/codex', spawn: fake.spawn });
    expect(result).toBe('unsupported');
  });

  it('unsupported (no throw) when the child fails to spawn', async () => {
    const fake = makeFake({ spawnError: true });
    const result = await injectDirective('t', 'x', {
      codexBin: '/fake/codex',
      spawn: fake.spawn,
      timeoutMs: 3000,
    });
    expect(result).toBe('unsupported');
  });

  it('unsupported when codex binary is absent', async () => {
    const result = await injectDirective('t', 'x', { codexBin: '' });
    expect(result).toBe('unsupported');
  });
});
