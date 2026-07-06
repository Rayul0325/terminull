import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SessionStatusDtoSchema } from '@terminull/shared';
import {
  parseStatusLine,
  statusLineToSessionStatus,
  type StatusLineInput,
} from '../src/statusline';

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

describe('statusLineToSessionStatus (M9 GATE oracle f — golden fold)', () => {
  it('folds the golden payload with the §D5 exact numbers and passes the wire schema', () => {
    const parsed = parseStatusLine(FULL)!;
    const dto = statusLineToSessionStatus(parsed, { now: 1_752_000_000_000 });
    // Round-trips the shared schema — the exact DTO the shim will POST.
    expect(SessionStatusDtoSchema.parse(dto)).toEqual(dto);
    expect(dto).toEqual({
      toolId: 'claude',
      toolSessionId: '11111111-2222-3333-4444-555555555555',
      model: { id: 'claude-fable-5', label: 'Fable 5' },
      contextTokens: {
        // input + cache_creation + cache_read + output — contract-pinned sum.
        used: 4210 + 2048 + 149120 + 812,
        max: 1000000,
        // Source-reported percentage, NOT recomputed.
        usedPercent: 17.1,
      },
      costUsd: 0.4212,
      asOf: 1_752_000_000_000,
    });
  });

  it('a fixture missing cost/context folds to honest nulls, never zeros', () => {
    const stripped = JSON.parse(FULL) as Record<string, unknown>;
    delete stripped['cost'];
    delete stripped['context_window'];
    const parsed = parseStatusLine(stripped)!;
    expect(parsed).not.toBeNull();
    const dto = statusLineToSessionStatus(parsed, { now: 1 });
    expect(SessionStatusDtoSchema.parse(dto)).toEqual(dto);
    expect(dto.contextTokens).toBeNull();
    expect(dto.costUsd).toBeNull();
    expect(dto.model).toEqual({ id: 'claude-fable-5', label: 'Fable 5' });
  });

  it('minimal payload: a REPORTED zero cost stays 0 (reported ≠ absent)', () => {
    const dto = statusLineToSessionStatus(parseStatusLine(MINIMAL)!, { now: 2 });
    expect(dto.costUsd).toBe(0);
    expect(dto.contextTokens).toEqual({ used: 0, max: 200000, usedPercent: 0 });
    expect(dto.toolSessionId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });
});
