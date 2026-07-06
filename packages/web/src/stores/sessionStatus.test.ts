/**
 * Session statusbar store tests (M9 W3, oracle f — web half). A golden
 * SessionStatusDto (the §D5 statusline fold shape) ingests via the postable
 * `session.status` event and via the REST seed; the LATEST payload per
 * (toolId, toolSessionId) wins; invalid payloads are DROPPED, never coerced;
 * missing cost/context stay null (never 0). All fetches mocked.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Envelope, SessionStatusDto } from '@terminull/shared';
import { setFetchImpl } from '../api/client';
import { asSessionStatus, statusKeyOf, useSessionStatusStore } from './sessionStatus';

let restoreFetch: (() => void) | null = null;
let seq = 0;

afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
  seq = 0;
  useSessionStatusStore.setState({ statuses: {}, seeded: {} });
});

/** Golden DTO — the exact §D5 fold of a full claude statusline payload. */
const GOLDEN: SessionStatusDto = {
  toolId: 'claude',
  toolSessionId: 'sess-abc',
  model: { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  contextTokens: { used: 123_456, max: 200_000, usedPercent: 61.7 },
  costUsd: 1.2345,
  asOf: 1_700_000_000_000,
};

function ev(payload: unknown): Envelope {
  seq += 1;
  return {
    seq,
    ts: 1000 + seq,
    v: 1,
    type: 'session.status',
    machine: 'test',
    actor: 'hook',
    payload,
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('asSessionStatus payload guard', () => {
  it('accepts the golden DTO verbatim', () => {
    expect(asSessionStatus(GOLDEN)).toEqual(GOLDEN);
  });

  it('missing cost/context fold to null — never 0', () => {
    const dto = asSessionStatus({
      toolId: 'claude',
      toolSessionId: 's',
      model: null,
      contextTokens: null,
      costUsd: null,
      asOf: null,
    });
    expect(dto).toEqual({
      toolId: 'claude',
      toolSessionId: 's',
      model: null,
      contextTokens: null,
      costUsd: null,
      asOf: null,
    });
    expect(dto?.costUsd).not.toBe(0);
  });

  it('drops malformed payloads instead of coercing them', () => {
    expect(asSessionStatus(null)).toBeNull();
    expect(asSessionStatus({ toolSessionId: 's' })).toBeNull();
    expect(asSessionStatus({ toolId: 'claude', toolSessionId: 's', model: 'opus' })).toBeNull();
    expect(
      asSessionStatus({
        toolId: 'claude',
        toolSessionId: 's',
        contextTokens: { used: 'many', max: 1, usedPercent: 1 },
      }),
    ).toBeNull();
  });
});

describe('session.status ingest', () => {
  it('folds the LATEST payload per (toolId, toolSessionId)', () => {
    const store = useSessionStatusStore.getState();
    store.applyEvents([ev(GOLDEN), ev({ ...GOLDEN, costUsd: 2.5 })]);
    const key = statusKeyOf('claude', 'sess-abc');
    expect(useSessionStatusStore.getState().statuses[key]?.costUsd).toBe(2.5);
  });

  it('an invalid stream payload leaves the fold untouched', () => {
    useSessionStatusStore.getState().applyEvents([ev(GOLDEN)]);
    useSessionStatusStore.getState().applyEvents([ev({ toolId: 42 })]);
    const key = statusKeyOf('claude', 'sess-abc');
    expect(useSessionStatusStore.getState().statuses[key]).toEqual(GOLDEN);
  });
});

describe('REST seed', () => {
  it('seeds from GET /api/sessions/:sid/status and never refetches the key', async () => {
    const calls: string[] = [];
    restoreFetch = setFetchImpl((url) => {
      calls.push(url);
      return Promise.resolve(json(200, { status: GOLDEN }));
    });
    await useSessionStatusStore.getState().seed('claude', 'sess-abc');
    await useSessionStatusStore.getState().seed('claude', 'sess-abc');
    expect(calls).toEqual(['/api/sessions/sess-abc/status']);
    expect(useSessionStatusStore.getState().statuses[statusKeyOf('claude', 'sess-abc')]).toEqual(
      GOLDEN,
    );
  });

  it('a null REST status stays honest no-data (no entry, no fabricated zeros)', async () => {
    restoreFetch = setFetchImpl(() => Promise.resolve(json(200, { status: null })));
    await useSessionStatusStore.getState().seed('codex', 'sess-x');
    expect(
      useSessionStatusStore.getState().statuses[statusKeyOf('codex', 'sess-x')],
    ).toBeUndefined();
  });

  it('a stream fold that landed during the seed wins over the seed response', async () => {
    let release: (() => void) | null = null;
    restoreFetch = setFetchImpl(
      () =>
        new Promise((resolve) => {
          release = () => resolve(json(200, { status: { ...GOLDEN, costUsd: 0.1 } }));
        }),
    );
    const seeding = useSessionStatusStore.getState().seed('claude', 'sess-abc');
    useSessionStatusStore.getState().applyEvents([ev({ ...GOLDEN, costUsd: 9.9 })]);
    release!();
    await seeding;
    expect(
      useSessionStatusStore.getState().statuses[statusKeyOf('claude', 'sess-abc')]?.costUsd,
    ).toBe(9.9);
  });
});
