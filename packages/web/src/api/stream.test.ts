/**
 * Event-stream tests with an injected fake WebSocket + synchronous flush:
 * ordered batching, hello catch-up, mid-stream gap → REST resync, and the
 * lost-history gap flag.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Envelope } from '@terminull/shared';
import { setFetchImpl } from './client';
import { EventStream, type WebSocketLike } from './stream';

class FakeWs implements WebSocketLike {
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  closed = false;
  close(): void {
    this.closed = true;
    this.onclose?.();
  }
  emit(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

function envelope(seq: number, type = 'session.activity'): Envelope {
  return { seq, ts: seq, v: 1, type, machine: 'test', actor: 'system' };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

let restoreFetch: (() => void) | null = null;

afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
});

async function tick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

function makeStream(ws: FakeWs): {
  stream: EventStream;
  batches: Envelope[][];
  statuses: string[];
  gaps: number[];
} {
  const batches: Envelope[][] = [];
  const statuses: string[] = [];
  const gaps: number[] = [];
  const stream = new EventStream({
    url: 'ws://test/ws',
    wsFactory: () => ws,
    schedule: (flush) => flush(), // synchronous flush in tests
    handlers: {
      onEvents: (batch) => batches.push(batch),
      onStatus: (s) => statuses.push(s),
      onGap: () => gaps.push(1),
    },
  });
  return { stream, batches, statuses, gaps };
}

describe('EventStream', () => {
  it('streams contiguous events in order after hello', async () => {
    const ws = new FakeWs();
    const { stream, batches, statuses } = makeStream(ws);
    stream.start();
    ws.emit({ t: 'hello', proto: 1, seq: 0 });
    ws.emit({ t: 'event', event: envelope(1) });
    ws.emit({ t: 'event', event: envelope(2) });
    ws.emit({ t: 'event', event: envelope(3) });
    await tick();
    const seqs = batches.flat().map((e) => e.seq);
    expect(seqs).toEqual([1, 2, 3]);
    expect(stream.lastSeq).toBe(3);
    expect(statuses).toContain('online');
    stream.stop();
  });

  it('hello with a higher seq triggers a REST catch-up first', async () => {
    const ws = new FakeWs();
    const calls: string[] = [];
    restoreFetch = setFetchImpl((input) => {
      calls.push(input);
      return Promise.resolve(
        jsonResponse({ events: [envelope(1), envelope(2)], seq: 2, gap: false }),
      );
    });
    const { stream, batches } = makeStream(ws);
    stream.start();
    ws.emit({ t: 'hello', proto: 1, seq: 2 });
    await tick();
    expect(calls).toEqual(['/api/events?since=0']);
    expect(batches.flat().map((e) => e.seq)).toEqual([1, 2]);
    stream.stop();
  });

  it('a mid-stream seq hole resyncs over REST exactly from lastSeq', async () => {
    const ws = new FakeWs();
    const calls: string[] = [];
    restoreFetch = setFetchImpl((input) => {
      calls.push(input);
      return Promise.resolve(
        jsonResponse({ events: [envelope(2), envelope(3)], seq: 3, gap: false }),
      );
    });
    const { stream, batches } = makeStream(ws);
    stream.start();
    ws.emit({ t: 'hello', proto: 1, seq: 0 });
    ws.emit({ t: 'event', event: envelope(1) });
    ws.emit({ t: 'event', event: envelope(3) }); // hole: 2 missing
    await tick();
    expect(calls).toEqual(['/api/events?since=1']);
    expect(batches.flat().map((e) => e.seq)).toEqual([1, 2, 3]);
    stream.stop();
  });

  it('server-reported inbox gap fires onGap so snapshots refetch', async () => {
    const ws = new FakeWs();
    restoreFetch = setFetchImpl(() =>
      Promise.resolve(jsonResponse({ events: [envelope(900)], seq: 900, gap: true })),
    );
    const { stream, gaps } = makeStream(ws);
    stream.start();
    ws.emit({ t: 'hello', proto: 1, seq: 900 });
    await tick();
    expect(gaps).toHaveLength(1);
    stream.stop();
  });

  it('duplicate seqs from resync overlap are dropped', async () => {
    const ws = new FakeWs();
    const { stream, batches } = makeStream(ws);
    stream.start();
    ws.emit({ t: 'hello', proto: 1, seq: 0 });
    ws.emit({ t: 'event', event: envelope(1) });
    ws.emit({ t: 'event', event: envelope(1) });
    await tick();
    expect(batches.flat().map((e) => e.seq)).toEqual([1]);
    stream.stop();
  });
});
