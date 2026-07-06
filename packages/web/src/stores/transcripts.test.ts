/**
 * Windowed transcript store tests: cursor continuation, honest
 * supported:false, client-side window cap with truncatedHead, LRU eviction.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { setFetchImpl } from '../api/client';
import type { ChatItem } from '../api/types';
import { MAX_ITEMS_PER_SESSION, MAX_SESSIONS, useTranscriptsStore } from './transcripts';

let restoreFetch: (() => void) | null = null;

afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
  useTranscriptsStore.setState({ entries: {} });
});

function items(from: number, count: number): ChatItem[] {
  return Array.from({ length: count }, (_v, i) => ({
    id: `c${from + i}`,
    role: 'agent' as const,
    kind: 'message' as const,
    text: `t${from + i}`,
  }));
}

function respondWindows(windows: Record<string, unknown>): string[] {
  const calls: string[] = [];
  restoreFetch = setFetchImpl((input) => {
    calls.push(input);
    const body = windows[input] ?? { supported: false, reason: 'no_fixture' };
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  return calls;
}

describe('transcript windows', () => {
  it('continues from the returned cursor without repeats', async () => {
    const calls = respondWindows({
      '/api/sessions/s1/transcript': {
        supported: true,
        items: items(0, 2),
        cursor: { offset: 100 },
        done: false,
      },
      '/api/sessions/s1/transcript?cursor=100': {
        supported: true,
        items: items(2, 1),
        cursor: { offset: 150 },
        done: true,
      },
    });
    const store = useTranscriptsStore.getState();
    await store.fetchMore('s1');
    await store.fetchMore('s1');
    const entry = useTranscriptsStore.getState().entries['s1']!;
    expect(calls).toEqual(['/api/sessions/s1/transcript', '/api/sessions/s1/transcript?cursor=100']);
    expect(entry.items.map((i) => i.id)).toEqual(['c0', 'c1', 'c2']);
    expect(entry.cursor).toBe(150);
    expect(entry.done).toBe(true);
  });

  it('supported:false is stored honestly with its reason code', async () => {
    respondWindows({
      '/api/sessions/s2/transcript': { supported: false, reason: 'no_transcript' },
    });
    await useTranscriptsStore.getState().fetchMore('s2');
    const entry = useTranscriptsStore.getState().entries['s2']!;
    expect(entry.supported).toBe(false);
    expect(entry.reasonCode).toBe('no_transcript');
  });

  it('caps the client window and flags truncatedHead', async () => {
    respondWindows({
      '/api/sessions/s3/transcript': {
        supported: true,
        items: items(0, MAX_ITEMS_PER_SESSION + 50),
        cursor: { offset: 1 },
        done: true,
      },
    });
    await useTranscriptsStore.getState().fetchMore('s3');
    const entry = useTranscriptsStore.getState().entries['s3']!;
    expect(entry.items).toHaveLength(MAX_ITEMS_PER_SESSION);
    expect(entry.truncatedHead).toBe(true);
    // The newest items survive, not the oldest.
    expect(entry.items[entry.items.length - 1]!.id).toBe(`c${MAX_ITEMS_PER_SESSION + 49}`);
  });

  it('a server reset drops the accumulated window instead of mixing runs', async () => {
    respondWindows({
      '/api/sessions/s4/transcript': {
        supported: true,
        items: items(0, 3),
        cursor: { offset: 10 },
        done: false,
      },
      '/api/sessions/s4/transcript?cursor=10': {
        supported: true,
        items: items(100, 1),
        cursor: { offset: 5 },
        done: true,
        reset: true,
      },
    });
    const store = useTranscriptsStore.getState();
    await store.fetchMore('s4');
    await store.fetchMore('s4');
    const entry = useTranscriptsStore.getState().entries['s4']!;
    expect(entry.items.map((i) => i.id)).toEqual(['c100']);
    expect(entry.truncatedHead).toBe(true);
  });

  it('evicts the least-recently-used session beyond the cap', () => {
    const store = useTranscriptsStore.getState();
    for (let i = 0; i < MAX_SESSIONS + 2; i++) store.touch(`lru-${i}`);
    const ids = Object.keys(useTranscriptsStore.getState().entries);
    expect(ids).toHaveLength(MAX_SESSIONS);
    expect(ids).not.toContain('lru-0');
    expect(ids).not.toContain('lru-1');
    expect(ids).toContain(`lru-${MAX_SESSIONS + 1}`);
  });
});
