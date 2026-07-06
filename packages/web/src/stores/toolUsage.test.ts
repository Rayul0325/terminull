/**
 * Usage-gauge store tests: freshness metadata passes through verbatim
 * (stale-turn-gated is the codex case), 422 adapter_unsupported is a normal
 * unsupported state, and available:false keeps the adapter's reason.
 * All fetches mocked.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { setFetchImpl } from '../api/client';
import { useToolUsageStore } from './toolUsage';

let restoreFetch: (() => void) | null = null;

afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
  useToolUsageStore.setState({ entries: {} });
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const CODEX_GAUGE = {
  toolId: 'codex',
  available: true,
  windows: [
    { label: '5h', usedPercent: 41, resetsAt: 1900000000000, slot: 'primary' },
    { label: '7d', usedPercent: 12, slot: 'secondary' },
  ],
  freshness: 'stale-turn-gated',
  asOf: 1899990000000,
  note: { en: 'Updated only when a turn runs', ko: '턴 실행 시에만 갱신' },
};

describe('tool usage store', () => {
  it('keeps stale-turn-gated freshness and asOf verbatim (codex case)', async () => {
    restoreFetch = setFetchImpl((url) => {
      if (url.endsWith('/usage')) return Promise.resolve(json(200, CODEX_GAUGE));
      return Promise.resolve(
        json(200, {
          whoami: { available: true, value: { account: 'dev@example.com', plan: 'plus' } },
          profiles: { available: false, reason: { en: 'n/a', ko: '없음' } },
        }),
      );
    });
    await useToolUsageStore.getState().load('codex');
    const entry = useToolUsageStore.getState().entries['codex']!;
    expect(entry.supported).toBe(true);
    expect(entry.gauge?.freshness).toBe('stale-turn-gated');
    expect(entry.gauge?.asOf).toBe(1899990000000);
    expect(entry.gauge?.windows).toHaveLength(2);
    expect(entry.account?.whoami).toMatchObject({ available: true });
  });

  it('422 adapter_unsupported is a normal unsupported state, not an error gauge', async () => {
    restoreFetch = setFetchImpl(() =>
      Promise.resolve(json(422, { code: 'adapter_unsupported', operation: 'usage' })),
    );
    await useToolUsageStore.getState().load('generic-pty');
    const entry = useToolUsageStore.getState().entries['generic-pty']!;
    expect(entry.supported).toBe(false);
    expect(entry.gauge).toBeNull();
    expect(entry.errorCode).toBe('adapter_unsupported');
  });

  it('available:false keeps the adapter-supplied reason for honest display', async () => {
    restoreFetch = setFetchImpl((url) => {
      if (url.endsWith('/usage')) {
        return Promise.resolve(
          json(200, {
            toolId: 'codex',
            available: false,
            windows: [],
            freshness: 'live',
            reason: { en: 'No usage data recorded yet', ko: '아직 기록된 사용량이 없습니다' },
          }),
        );
      }
      return Promise.resolve(json(404, { code: 'not_found' }));
    });
    await useToolUsageStore.getState().load('codex');
    const entry = useToolUsageStore.getState().entries['codex']!;
    expect(entry.supported).toBe(true);
    expect(entry.gauge?.available).toBe(false);
    expect(entry.gauge?.reason?.ko).toBe('아직 기록된 사용량이 없습니다');
    // Account fetch failed independently — gauge unaffected, account null.
    expect(entry.account).toBeNull();
  });

  it('a transport failure surfaces as a code without fabricating a gauge', async () => {
    restoreFetch = setFetchImpl(() => Promise.reject(new Error('boom')));
    await useToolUsageStore.getState().load('codex');
    const entry = useToolUsageStore.getState().entries['codex']!;
    expect(entry.errorCode).toBe('network');
    expect(entry.gauge).toBeNull();
  });
});
