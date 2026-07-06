import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseStatusLine, type StatusLineInput } from '../src/statusline';

const readFixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/harness/${name}`, import.meta.url)), 'utf8');

const FULL = readFixture('statusline-stdin.json');
const MINIMAL = readFixture('statusline-stdin-minimal.json');

describe('parseStatusLine', () => {
  it('parses the full §5 payload and narrows every block', () => {
    const s = parseStatusLine(FULL);
    expect(s).not.toBeNull();
    const v = s as StatusLineInput;
    expect(v.session_id).toBe('11111111-2222-3333-4444-555555555555');
    expect(v.model).toEqual({ id: 'claude-fable-5', display_name: 'Fable 5' });
    expect(v.cost.total_cost_usd).toBeCloseTo(0.4212);
    expect(v.context_window.context_window_size).toBe(1000000);
    expect(v.context_window.current_usage.cache_read_input_tokens).toBe(149120);
    expect(v.workspace.repo).toEqual({ host: 'github.com', owner: 'example', name: 'proj' });
    expect(v.effort?.level).toBe('high');
    expect(v.thinking.enabled).toBe(true);
    expect(v.pr?.review_state).toBe('APPROVED');
    expect(v.worktree?.branch).toBe('parity-work');
    expect(v.exceeds_200k_tokens).toBe(false);
  });

  it('parses the minimal payload (required fields only, optionals absent)', () => {
    const s = parseStatusLine(MINIMAL);
    expect(s).not.toBeNull();
    const v = s as StatusLineInput;
    expect(v.model.id).toBe('sonnet');
    expect(v.workspace.added_dirs).toEqual([]);
    expect(v.thinking.enabled).toBe(false);
    // Optional blocks are genuinely absent, never fabricated.
    expect(v.pr).toBeUndefined();
    expect(v.worktree).toBeUndefined();
    expect(v.effort).toBeUndefined();
    expect(v.rate_limits).toBeUndefined();
  });

  it('accepts an already-parsed object, not only a JSON string', () => {
    const obj = JSON.parse(MINIMAL) as unknown;
    expect(parseStatusLine(obj)?.session_id).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });

  it('returns null (never throws) for non-JSON, non-object, or non-statusline blobs', () => {
    expect(parseStatusLine('not json {')).toBeNull();
    expect(parseStatusLine('42')).toBeNull();
    expect(parseStatusLine('[1,2,3]')).toBeNull();
    expect(parseStatusLine(null)).toBeNull();
    expect(parseStatusLine(undefined)).toBeNull();
    expect(parseStatusLine({ session_id: 'x' })).toBeNull(); // missing transcript_path + model.id
    expect(parseStatusLine({ session_id: 'x', transcript_path: '/t' })).toBeNull(); // missing model.id
    expect(parseStatusLine({ session_id: 'x', transcript_path: '/t', model: {} })).toBeNull();
  });
});
