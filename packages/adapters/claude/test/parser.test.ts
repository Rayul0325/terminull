import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ChatItem, TranscriptRef } from '@terminull/adapter-sdk';
import { ClaudeTranscriptParser } from '../src/parser';

const GOLDEN = fileURLToPath(new URL('./fixtures/golden-session.jsonl', import.meta.url));
const ref: TranscriptRef = { kind: 'file', path: GOLDEN };

/** The stable expected normalisation of the golden fixture (8 items). */
const EXPECTED: ChatItem[] = [
  { id: 'c0.0', role: 'user', kind: 'message', text: 'hello there' },
  {
    id: 'c1.0',
    role: 'agent',
    kind: 'message',
    text: 'Hi! Let me help.',
    ts: Date.parse('2026-07-06T00:00:02.000Z'),
  },
  {
    id: 'c2.0',
    role: 'agent',
    kind: 'tool_call',
    text: 'List files',
    raw: {
      semantic: 'tool_use',
      name: 'Bash',
      input: { command: 'ls -la', description: 'List files' },
    },
  },
  {
    id: 'c3.0',
    role: 'agent',
    kind: 'tool_call',
    text: 'b/c.ts',
    raw: { semantic: 'tool_use', name: 'Write', input: { file_path: '/a/b/c.ts', content: 'x' } },
  },
  {
    id: 'c4.0',
    role: 'agent',
    kind: 'tool_call',
    text: 'Which option?',
    raw: {
      semantic: 'tool_use',
      name: 'AskUserQuestion',
      input: { questions: [{ question: 'Which option?' }] },
    },
  },
  {
    id: 'c5.0',
    role: 'agent',
    kind: 'tool_call',
    text: 'plan approval requested',
    raw: { semantic: 'tool_use', name: 'ExitPlanMode', input: { plan: 'do the thing' } },
  },
  {
    // The sidechain record is no longer dropped: it emits ONE bounded marker
    // (identity only — the subagent's content is never surfaced).
    id: 'c6.0',
    role: 'system',
    kind: 'sidechain',
    text: 'subagent thread',
    raw: { semantic: 'sidechain', recordType: 'assistant' },
  },
  {
    id: 'c8.0',
    role: 'user',
    kind: 'event',
    text: '/checkpoint save now',
    raw: { semantic: 'command', command: '/checkpoint', args: 'save now' },
  },
  { id: 'c9.0', role: 'user', kind: 'message', text: 'real question here' },
];

describe('ClaudeTranscriptParser — golden fixture', () => {
  it('normalises the fixture into the stable expected ChatItems', async () => {
    const w = await new ClaudeTranscriptParser().readWindowDetailed(ref);
    expect(w.items).toEqual(EXPECTED);
  });

  it('emits a bounded sidechain marker (not content), still skips meta, strips the reminder', async () => {
    const w = await new ClaudeTranscriptParser().readWindowDetailed(ref);
    const texts = w.items.map((i) => i.text);
    expect(texts).not.toContain('subagent chatter'); // subagent CONTENT never surfaced
    expect(texts).not.toContain('meta noise'); // meta still skipped
    expect(texts).toContain('real question here'); // reminder stripped, text kept
    expect(texts.some((t) => t?.includes('<system-reminder>'))).toBe(false);
    // …but the subagent thread IS marked so M6 can group it.
    const marker = w.items.find((i) => i.kind === 'sidechain');
    expect(marker?.role).toBe('system');
    expect((marker?.raw as { semantic?: string })?.semantic).toBe('sidechain');
  });

  it('renders a slash command as a compact command event, not raw XML', async () => {
    const w = await new ClaudeTranscriptParser().readWindowDetailed(ref);
    const cmd = w.items.find((i) => i.kind === 'event');
    expect(cmd?.text).toBe('/checkpoint save now');
    expect(cmd?.role).toBe('user');
  });

  it('drops the torn final line and stops the cursor before it (no unparsed item)', async () => {
    const w = await new ClaudeTranscriptParser().readWindowDetailed(ref);
    expect(w.items).toHaveLength(9);
    expect(w.items.some((i) => (i.raw as { semantic?: string })?.semantic === 'unparsed')).toBe(
      false,
    );
    const size = (await import('node:fs')).statSync(GOLDEN).size;
    // Cursor stops at the last complete newline, strictly before EOF (torn tail).
    expect(w.cursor.offset).toBeLessThan(size);
    expect(w.cursor.kind).toBe('byte');
  });

  it('has a monotonic cursor across a follow read', async () => {
    const parser = new ClaudeTranscriptParser();
    const first = await parser.readWindowDetailed(ref);
    const second = await parser.readWindowDetailed(ref, first.cursor);
    expect(second.cursor.offset).toBeGreaterThanOrEqual(first.cursor.offset);
    expect(second.items).toHaveLength(0); // nothing new past the torn tail
  });

  it('flags reset when the cursor is past EOF (shrunk/rotated file)', async () => {
    const w = await new ClaudeTranscriptParser().readWindowDetailed(ref, { offset: 10_000_000 });
    expect(w.reset).toBe(true);
  });
});

describe('ClaudeTranscriptParser — window truncation flags', () => {
  it('flags truncatedHead when the initial window starts mid-file', async () => {
    // A small initial window forces start > 0 → the visible head is omitted,
    // while still spanning at least one complete line (the last record).
    const w = await new ClaudeTranscriptParser({ initialWindow: 250 }).readWindowDetailed(ref);
    expect(w.truncatedHead).toBe(true);
    expect(w.items.length).toBeGreaterThan(0);
  });

  it('flags droppedOlder and caps items when more parse than maxItems allows', async () => {
    const w = await new ClaudeTranscriptParser({ maxItems: 2 }).readWindowDetailed(ref);
    expect(w.droppedOlder).toBe(true);
    expect(w.items).toHaveLength(2);
    expect(w.truncatedHead).toBe(true); // initial + droppedOlder ⇒ head omitted
  });

  it('does not truncate the head on a normal full-window read', async () => {
    const w = await new ClaudeTranscriptParser().readWindowDetailed(ref);
    expect(w.truncatedHead).toBe(false);
    expect(w.droppedOlder).toBe(false);
    expect(w.reset).toBe(false);
  });
});
