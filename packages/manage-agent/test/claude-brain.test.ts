/**
 * ClaudeBrainAdapter unit tests — scripted child stub ONLY. These tests never
 * spawn the real `claude` CLI (every adapter gets `spawnFn` injected), and
 * the only model names appearing anywhere are sonnet/haiku.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  ClaudeBrainAdapter,
  composeTurnPrompt,
  parseStreamJsonLine,
  type BrainEvent,
  type BrainSpawn,
  type BrainSpawnOptions,
  type BrainTurnInput,
} from '../src/index.js';

const FIXTURE = fs.readFileSync(new URL('./fixtures/claude-stream.jsonl', import.meta.url), 'utf8');

/** Scripted stand-in for a spawned child process. */
class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  kills: NodeJS.Signals[] = [];
  stdinData = '';

  constructor() {
    super();
    this.stdin.on('data', (chunk) => {
      this.stdinData += String(chunk);
    });
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.kills.push(signal ?? 'SIGTERM');
    return true;
  }
}

interface SpawnCall {
  command: string;
  args: readonly string[];
  options: BrainSpawnOptions;
}

function scriptedSpawn(child: FakeChild): { spawnFn: BrainSpawn; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const spawnFn: BrainSpawn = (command, args, options) => {
    calls.push({ command, args, options });
    return child;
  };
  return { spawnFn, calls };
}

const TURN_INPUT: BrainTurnInput = {
  turnId: 't1',
  system: 'You are the supervisor system prompt.',
  messages: [{ role: 'user', text: 'what is the fleet doing?' }],
};

async function collect(iterable: AsyncIterable<BrainEvent>): Promise<BrainEvent[]> {
  const events: BrainEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('ClaudeBrainAdapter.runTurn', () => {
  it('parses the golden stream-json fixture into the documented event order', async () => {
    const child = new FakeChild();
    const { spawnFn, calls } = scriptedSpawn(child);
    const adapter = new ClaudeBrainAdapter({ spawnFn });

    const pending = collect(adapter.runTurn(TURN_INPUT));
    child.stdout.end(FIXTURE);
    const events = await pending;

    expect(events).toEqual([
      { kind: 'text', text: 'Looking at the fleet.' },
      {
        kind: 'action',
        action: { kind: 'create_board_card', title: 'Investigate stuck session' },
        reason: 'session s1 idle for 2h',
      },
      { kind: 'text', text: 'Card proposed. Done.' },
      { kind: 'usage', costUsd: 0.0123, inputTokens: 100, outputTokens: 50 },
      { kind: 'done', stopReason: 'end_turn' },
    ]);

    // Spawn contract: headless stream-json flags, configured model (default
    // sonnet — never a hardcoded top tier), no shell option at all.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe('claude');
    expect(calls[0]!.args).toEqual(['-p', '--output-format', 'stream-json', '--verbose', '--model', 'sonnet']);
    expect('shell' in calls[0]!.options).toBe(false);

    // Prompt travels via stdin (system + conversation), not argv.
    expect(child.stdinData).toBe(composeTurnPrompt(TURN_INPUT));
    expect(child.stdinData).toContain('You are the supervisor system prompt.');
    expect(child.stdinData).toContain('what is the fleet doing?');
  });

  it('passes a configured model through (haiku)', async () => {
    const child = new FakeChild();
    const { spawnFn, calls } = scriptedSpawn(child);
    const adapter = new ClaudeBrainAdapter({ spawnFn, model: 'haiku' });
    const pending = collect(adapter.runTurn(TURN_INPUT));
    child.stdout.end(FIXTURE);
    await pending;
    expect(calls[0]!.args).toContain('haiku');
  });

  it('kills the child and ends with done:interrupted on abort', async () => {
    const child = new FakeChild();
    const { spawnFn } = scriptedSpawn(child);
    const adapter = new ClaudeBrainAdapter({ spawnFn });
    const controller = new AbortController();

    const pending = collect(adapter.runTurn(TURN_INPUT, controller.signal));
    await tick(); // let the generator spawn + attach listeners
    controller.abort();
    const events = await pending;

    expect(events.at(-1)).toEqual({ kind: 'done', stopReason: 'interrupted' });
    expect(child.kills).toContain('SIGTERM');
  });

  it('short-circuits an already-aborted signal without spawning', async () => {
    const child = new FakeChild();
    const { spawnFn, calls } = scriptedSpawn(child);
    const adapter = new ClaudeBrainAdapter({ spawnFn });
    const controller = new AbortController();
    controller.abort();
    const events = await collect(adapter.runTurn(TURN_INPUT, controller.signal));
    expect(events).toEqual([{ kind: 'done', stopReason: 'interrupted' }]);
    expect(calls).toHaveLength(0);
  });

  it('reports a stream that ends without a result record as an error, honestly', async () => {
    const child = new FakeChild();
    const { spawnFn } = scriptedSpawn(child);
    const adapter = new ClaudeBrainAdapter({ spawnFn });

    const pending = collect(adapter.runTurn(TURN_INPUT));
    child.stdout.end('{"type":"system","subtype":"init"}\n');
    await tick();
    child.stderr.end('boom\n');
    await tick();
    child.emit('close', 1, null);
    const events = await pending;

    const error = events.find((e) => e.kind === 'error');
    expect(error).toMatchObject({ kind: 'error', code: 'exit_1', detail: 'boom' });
    expect(events.at(-1)).toEqual({ kind: 'done', stopReason: 'error' });
  });

  it('kills the child and reports error on turn timeout', async () => {
    const child = new FakeChild();
    const { spawnFn } = scriptedSpawn(child);
    const adapter = new ClaudeBrainAdapter({ spawnFn, turnTimeoutMs: 20, killGraceMs: 10 });
    const events = await collect(adapter.runTurn(TURN_INPUT));
    expect(events[0]).toMatchObject({ kind: 'error', code: 'timeout' });
    expect(events.at(-1)).toEqual({ kind: 'done', stopReason: 'error' });
    expect(child.kills).toContain('SIGTERM');
  });
});

describe('ClaudeBrainAdapter.probe', () => {
  it('reports ok + version ONLY on exit 0 with real output', async () => {
    const child = new FakeChild();
    const { spawnFn, calls } = scriptedSpawn(child);
    const adapter = new ClaudeBrainAdapter({ spawnFn });
    const pending = adapter.probe();
    child.stdout.end('2.1.0 (Claude Code)\n');
    await tick();
    child.emit('close', 0, null);
    await expect(pending).resolves.toEqual({ availability: 'ok', version: '2.1.0 (Claude Code)' });
    expect(calls[0]!.args).toEqual(['--version']);
  });

  it('reports unavailable when the binary is missing (never fake green)', async () => {
    const child = new FakeChild();
    const { spawnFn } = scriptedSpawn(child);
    const adapter = new ClaudeBrainAdapter({ spawnFn });
    const pending = adapter.probe();
    await tick();
    child.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }));
    const probe = await pending;
    expect(probe.availability).toBe('unavailable');
    expect(probe.detail?.en).toContain('ENOENT');
    expect(probe.detail?.ko).toBeTruthy();
  });

  it('reports unavailable on exit 0 with EMPTY output (no output, no ok)', async () => {
    const child = new FakeChild();
    const { spawnFn } = scriptedSpawn(child);
    const adapter = new ClaudeBrainAdapter({ spawnFn });
    const pending = adapter.probe();
    await tick();
    child.emit('close', 0, null);
    const probe = await pending;
    expect(probe.availability).toBe('unavailable');
  });
});

describe('parseStreamJsonLine', () => {
  it('ignores blank lines, non-JSON noise and unknown record types', () => {
    expect(parseStreamJsonLine('')).toEqual([]);
    expect(parseStreamJsonLine('not json at all')).toEqual([]);
    expect(parseStreamJsonLine('{"type":"user","message":{}}')).toEqual([]);
  });

  it('surfaces an unparseable ACTION payload as an action event (loop denies it audited)', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'ACTION: {broken json' }] },
    });
    const events = parseStreamJsonLine(line);
    expect(events).toEqual([{ kind: 'action', action: '{broken json' }]);
  });

  it('maps an error result record to error + done:error', () => {
    const events = parseStreamJsonLine(
      JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, total_cost_usd: 0.002 }),
    );
    expect(events).toEqual([
      { kind: 'usage', costUsd: 0.002 },
      { kind: 'error', code: 'error_max_turns' },
      { kind: 'done', stopReason: 'error' },
    ]);
  });
});
