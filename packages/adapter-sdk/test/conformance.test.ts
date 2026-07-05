import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  minimalCapabilities,
  runAdapterConformance,
  type ChatItem,
  type ConformanceFixtures,
  type ToolAdapter,
  type TranscriptCursor,
  type TranscriptRef,
  type TranscriptWindow,
} from '../src/index';

const FIXTURE = fileURLToPath(new URL('./fixtures/transcript.jsonl', import.meta.url));

const baseFixtures: ConformanceFixtures = {
  probeContext: { cmd: 'node', which: () => '/usr/bin/node' },
  collectContext: {},
};

/** A minimal, fully-consistent adapter (all checks should pass). */
function goodAdapter(): ToolAdapter {
  return {
    id: 'good',
    displayName: { en: 'Good', ko: '굿' },
    capabilities: minimalCapabilities(),
    probe: () => Promise.resolve({ present: true, capabilities: {} }),
    collector: { collect: () => Promise.resolve([]) },
    driverFor: () => null, // not drivable: empty keymap + coDrive 'none'
    keymap: {},
    models: { list: () => Promise.resolve([]) },
  };
}

describe('runAdapterConformance — passing adapter', () => {
  it('passes a consistent adapter', async () => {
    const result = await runAdapterConformance(goodAdapter(), baseFixtures);
    expect(result.pass).toBe(true);
    expect(result.failures).toHaveLength(0);
  });
});

describe('runAdapterConformance — capability lies', () => {
  it('fails when transcript is declared but no parser is provided', async () => {
    const adapter = goodAdapter();
    adapter.capabilities = minimalCapabilities({ transcript: 'jsonl' });
    adapter.probe = () => Promise.resolve({ present: true, capabilities: { transcript: 'jsonl' } });

    const result = await runAdapterConformance(adapter, baseFixtures);
    expect(result.pass).toBe(false);
    const failure = result.failures.find((f) => f.check === 'parser-consistency');
    expect(failure?.message).toMatch(/transcript='jsonl' declared but no parser/);
  });

  it('fails when a declared capability is contradicted by the probe', async () => {
    const adapter = goodAdapter();
    adapter.capabilities = minimalCapabilities({ acp: true });
    adapter.probe = () => Promise.resolve({ present: true, capabilities: { acp: false } });

    const result = await runAdapterConformance(adapter, baseFixtures);
    expect(result.pass).toBe(false);
    expect(result.failures.some((f) => f.check === 'probe-consistency')).toBe(true);
  });

  it('fails when driverFor returns a driver for a non-drivable adapter', async () => {
    const adapter = goodAdapter();
    // Empty keymap + coDrive 'none' => not drivable, yet returns a driver.
    adapter.driverFor = () =>
      ({
        sendText: () => Promise.resolve(),
        sendKey: () => Promise.resolve(),
        answerMenu: () => Promise.resolve(),
        approvePlan: () => Promise.resolve(),
        setPermissionMode: () => Promise.resolve(),
        interrupt: () => Promise.resolve(),
        background: () => Promise.resolve(),
        rename: () => Promise.resolve(),
        detectPromptState: () => ({ kind: 'unknown' }),
      }) as ReturnType<ToolAdapter['driverFor']>;

    const result = await runAdapterConformance(adapter, baseFixtures);
    expect(result.failures.some((f) => f.check === 'drivability')).toBe(true);
  });
});

describe('runAdapterConformance — parser round-trip', () => {
  /** An adapter that actually parses the golden jsonl fixture. */
  function parsingAdapter(): ToolAdapter {
    const adapter = goodAdapter();
    adapter.id = 'jsonl';
    adapter.capabilities = minimalCapabilities({ transcript: 'jsonl' });
    adapter.probe = () => Promise.resolve({ present: true, capabilities: { transcript: 'jsonl' } });
    adapter.parser = {
      readWindow(ref: TranscriptRef, cursor?: TranscriptCursor): TranscriptWindow {
        if (ref.kind !== 'file') throw new Error('unsupported ref');
        const lines = readFileSync(ref.path, 'utf8')
          .split('\n')
          .filter((l) => l.trim().length > 0);
        const start = cursor?.offset ?? 0;
        const items: ChatItem[] = lines.slice(start).map((line, i) => {
          const rec = JSON.parse(line) as { role: ChatItem['role']; text: string };
          return { id: String(start + i), role: rec.role, kind: 'message', text: rec.text };
        });
        return { items, cursor: { offset: lines.length }, done: true };
      },
    };
    return adapter;
  }

  it('round-trips the golden fixture into schema-valid ChatItems, monotonic cursor', async () => {
    const result = await runAdapterConformance(parsingAdapter(), {
      ...baseFixtures,
      transcript: { ref: { kind: 'file', path: FIXTURE }, minItems: 4 },
    });
    expect(result.failures).toHaveLength(0);
    expect(result.pass).toBe(true);
  });
});
