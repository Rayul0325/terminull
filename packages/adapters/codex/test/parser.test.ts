import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ChatItem, TranscriptRef } from '@terminull/adapter-sdk';
import { CodexTranscriptParser } from '../src/parser';

const GOLDEN = fileURLToPath(new URL('./fixtures/golden-rollout.jsonl', import.meta.url));
const ref: TranscriptRef = { kind: 'file', path: GOLDEN };

/** The stable expected normalisation of the golden fixture (7 items). */
const EXPECTED: ChatItem[] = [
  { id: 'x3.0', role: 'user', kind: 'message', text: 'hello codex' },
  {
    id: 'x6.0',
    role: 'agent',
    kind: 'message',
    text: 'Hi, I can help.',
    ts: Date.parse('2026-07-06T00:00:02.000Z'),
  },
  {
    id: 'x8.0',
    role: 'agent',
    kind: 'tool_call',
    text: 'bash -lc ls -la',
    raw: {
      semantic: 'tool_use',
      name: 'exec_command',
      input: { command: ['bash', '-lc', 'ls -la'] },
    },
  },
  {
    id: 'x9.0',
    role: 'tool',
    kind: 'tool_result',
    text: 'exit 0: 2 files',
    raw: { semantic: 'tool_result', output: 'exit 0: 2 files' },
  },
  { id: 'x10.0', role: 'agent', kind: 'message', text: 'Only in the event stream' },
  {
    id: 'x12.0',
    role: 'agent',
    kind: 'tool_call',
    text: 'codex news',
    raw: { semantic: 'tool_use', name: 'web_search', input: { query: 'codex news' } },
  },
  {
    id: 'x13.0',
    role: 'system',
    kind: 'event',
    text: 'response_item:custom_widget',
    raw: { semantic: 'unparsed', type: 'response_item', payloadType: 'custom_widget' },
  },
];

describe('CodexTranscriptParser — golden fixture', () => {
  it('normalises every mapped payload type into the stable expected ChatItems', async () => {
    const w = await new CodexTranscriptParser().readWindowDetailed(ref);
    expect(w.items).toEqual(EXPECTED);
  });

  it('dedups the event_msg ⇄ response_item message twins (one item each)', async () => {
    const w = await new CodexTranscriptParser().readWindowDetailed(ref);
    const texts = w.items.map((i) => i.text);
    // 'hello codex' and 'Hi, I can help.' each appear in BOTH representations.
    expect(texts.filter((t) => t === 'hello codex')).toHaveLength(1);
    expect(texts.filter((t) => t === 'Hi, I can help.')).toHaveLength(1);
    // An event_msg with no response_item twin still emits.
    expect(texts).toContain('Only in the event stream');
  });

  it('drops metadata + reasoning + token_count, and maps exec/tool payloads to tool_use', async () => {
    const w = await new CodexTranscriptParser().readWindowDetailed(ref);
    // no session_meta / turn_context / developer message / reasoning leaked
    expect(w.items.some((i) => i.text?.includes('SYSTEM INSTRUCTIONS'))).toBe(false);
    const toolCalls = w.items.filter((i) => i.kind === 'tool_call');
    expect(toolCalls.map((i) => (i.raw as { name?: string }).name)).toEqual([
      'exec_command',
      'web_search',
    ]);
    // exec input structure preserved verbatim.
    const exec = toolCalls[0];
    expect((exec?.raw as { input?: unknown }).input).toEqual({
      command: ['bash', '-lc', 'ls -la'],
    });
  });

  it('records an honest unparsed event for an unknown payload type', async () => {
    const w = await new CodexTranscriptParser().readWindowDetailed(ref);
    const unparsed = w.items.filter(
      (i) => (i.raw as { semantic?: string })?.semantic === 'unparsed',
    );
    expect(unparsed).toHaveLength(1);
    expect(unparsed[0]?.role).toBe('system');
    expect(unparsed[0]?.kind).toBe('event');
  });

  it('drops the torn final line and stops the cursor strictly before EOF', async () => {
    const w = await new CodexTranscriptParser().readWindowDetailed(ref);
    // The torn tail must NOT surface as a parsed/unparsed item.
    expect(w.items.some((i) => i.text?.includes('assistan"'))).toBe(false);
    const size = fs.statSync(GOLDEN).size;
    expect(w.cursor.offset).toBeLessThan(size);
    expect(w.cursor.kind).toBe('byte');
  });

  it('has a monotonic cursor across a follow read (nothing new past the torn tail)', async () => {
    const parser = new CodexTranscriptParser();
    const first = await parser.readWindowDetailed(ref);
    const second = await parser.readWindowDetailed(ref, first.cursor);
    expect(second.cursor.offset).toBeGreaterThanOrEqual(first.cursor.offset);
    expect(second.items).toHaveLength(0);
  });

  it('flags reset when the cursor is past EOF (shrunk/rotated file)', async () => {
    const w = await new CodexTranscriptParser().readWindowDetailed(ref, { offset: 10_000_000 });
    expect(w.reset).toBe(true);
  });

  it('flags truncatedHead when the initial window starts mid-file', async () => {
    const w = await new CodexTranscriptParser({ initialWindow: 200 }).readWindowDetailed(ref);
    expect(w.truncatedHead).toBe(true);
    expect(w.items.length).toBeGreaterThan(0);
  });
});
