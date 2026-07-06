/**
 * Golden coverage for the 2026-07-06 record-kind extension.
 *
 * Fixture: `golden-session-v2.jsonl` — SYNTHETIC, hand-authored, captured-with
 * claude 2.1.201 (no real transcript content). One line per newly mapped kind:
 * thinking→reasoning, tool_use(+id), tool_result (success + error), sidechain
 * (with identity), system/summary/compaction→system, a P1-deferred `mode`
 * record (dropped), and a novel record type (unparsed fallback).
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ChatItem, TranscriptRef } from '@terminull/adapter-sdk';
import { ClaudeTranscriptParser } from '../src/parser';

const GOLDEN_V2 = fileURLToPath(new URL('./fixtures/golden-session-v2.jsonl', import.meta.url));
const ref: TranscriptRef = { kind: 'file', path: GOLDEN_V2 };

const raw = (i: ChatItem | undefined): Record<string, unknown> =>
  (i?.raw ?? {}) as Record<string, unknown>;

describe('ClaudeTranscriptParser — v2 record kinds', () => {
  it('maps every synthetic record to its stable ChatItem', async () => {
    const w = await new ClaudeTranscriptParser().readWindowDetailed(ref);
    // 10 records, the `mode` record (idx 8) is deferred → 9 items.
    expect(w.items.map((i) => i.id)).toEqual([
      'c0.0',
      'c1.0',
      'c2.0',
      'c3.0',
      'c4.0',
      'c5.0',
      'c6.0',
      'c7.0',
      'c9.0',
    ]);
  });

  it('emits thinking blocks as collapsible reasoning (text preserved)', async () => {
    const w = await new ClaudeTranscriptParser().readWindowDetailed(ref);
    const r = w.items[0];
    expect(r).toMatchObject({ id: 'c0.0', role: 'agent', kind: 'reasoning' });
    expect(r?.text).toBe('Let me reason about the layout first.');
    expect(raw(r)['semantic']).toBe('reasoning');
  });

  it('carries the tool_use pairing id and pairs it to its tool_result', async () => {
    const w = await new ClaudeTranscriptParser().readWindowDetailed(ref);
    const call = w.items.find((i) => i.kind === 'tool_call');
    const result = w.items.find((i) => i.kind === 'tool_result' && raw(i)['isError'] === false);
    expect(raw(call)['toolUseId']).toBe('toolu_01ABC');
    // The pairing key M6 needs to link the call to its output.
    expect(raw(result)['toolUseId']).toBe('toolu_01ABC');
  });

  it('renders a successful tool_result with role tool + preserved payload/envelope', async () => {
    const w = await new ClaudeTranscriptParser().readWindowDetailed(ref);
    const ok = w.items[2];
    expect(ok).toMatchObject({ id: 'c2.0', role: 'tool', kind: 'tool_result' });
    expect(ok?.text).toBe('export const app = 1;');
    expect(raw(ok)['isError']).toBe(false);
    expect(raw(ok)['payload']).toEqual([{ type: 'text', text: 'export const app = 1;' }]);
    expect(raw(ok)['toolUseResult']).toEqual({ stdout: 'export const app = 1;' });
  });

  it('renders an error tool_result with isError + string payload', async () => {
    const w = await new ClaudeTranscriptParser().readWindowDetailed(ref);
    const err = w.items[3];
    expect(err).toMatchObject({ id: 'c3.0', kind: 'tool_result' });
    expect(raw(err)['isError']).toBe(true);
    expect(err?.text).toBe('ENOENT: no such file');
    expect(raw(err)['payload']).toBe('ENOENT: no such file');
  });

  it('emits a sidechain marker with identity but never the subagent content', async () => {
    const w = await new ClaudeTranscriptParser().readWindowDetailed(ref);
    const marker = w.items[4];
    expect(marker).toMatchObject({ id: 'c4.0', role: 'system', kind: 'sidechain' });
    expect(marker?.text).toBe('subagent: Explore');
    expect(raw(marker)).toMatchObject({
      semantic: 'sidechain',
      slug: 'explore-src',
      agentType: 'Explore',
      recordType: 'assistant',
    });
    expect(w.items.map((i) => i.text)).not.toContain('internal subagent chatter');
  });

  it('folds system/summary/compaction records into system items with a subtype', async () => {
    const w = await new ClaudeTranscriptParser().readWindowDetailed(ref);
    const systems = w.items.filter((i) => i.kind === 'system');
    expect(systems.map((i) => raw(i)['subtype'])).toEqual([
      'compact_boundary',
      'summary',
      'compaction',
    ]);
    expect(systems.every((i) => i.role === 'system')).toBe(true);
  });

  it('drops the P1-deferred session-meta record (mode) — not surfaced as chat', async () => {
    const w = await new ClaudeTranscriptParser().readWindowDetailed(ref);
    expect(w.items.some((i) => raw(i)['recordType'] === 'mode')).toBe(false);
  });

  it('routes a novel record type to the honest unparsed fallback', async () => {
    const w = await new ClaudeTranscriptParser().readWindowDetailed(ref);
    const unknown = w.items[w.items.length - 1];
    expect(unknown).toMatchObject({ id: 'c9.0', role: 'system', kind: 'event' });
    expect(raw(unknown)).toMatchObject({ semantic: 'unparsed', recordType: 'quantum-flux-2099' });
  });

  it('keeps the cursor monotonic across a follow read (nothing new past EOF)', async () => {
    const parser = new ClaudeTranscriptParser();
    const first = await parser.readWindowDetailed(ref);
    const second = await parser.readWindowDetailed(ref, first.cursor);
    expect(second.cursor.offset).toBeGreaterThanOrEqual(first.cursor.offset);
    expect(second.items).toHaveLength(0);
  });
});
