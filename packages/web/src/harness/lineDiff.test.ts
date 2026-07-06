/**
 * Line-diff tests (M9 W2 save preview). Correctness bar: every changed line
 * appears exactly once with the right sign, identical inputs produce an empty
 * diff, and the large-input fallback is still a CORRECT (if non-minimal)
 * diff — reassembling "same+add" must reproduce `after`, "same+del" `before`.
 */
import { describe, expect, it } from 'vitest';
import { diffStats, lineDiff, type DiffRow } from './lineDiff';

function rebuildAfter(rows: DiffRow[]): string {
  return rows
    .filter((r) => r.type !== 'del')
    .map((r) => r.text)
    .join('\n');
}

function rebuildBefore(rows: DiffRow[]): string {
  return rows
    .filter((r) => r.type !== 'add')
    .map((r) => r.text)
    .join('\n');
}

describe('lineDiff', () => {
  it('identical inputs → empty diff', () => {
    expect(lineDiff('a\nb', 'a\nb')).toEqual([]);
    expect(lineDiff('', '')).toEqual([]);
  });

  it('a single changed line yields one del + one add between same rows', () => {
    const rows = lineDiff('a\nb\nc', 'a\nX\nc');
    expect(rows).toEqual([
      { type: 'same', text: 'a' },
      { type: 'del', text: 'b' },
      { type: 'add', text: 'X' },
      { type: 'same', text: 'c' },
    ]);
    expect(diffStats(rows)).toEqual({ added: 1, removed: 1 });
  });

  it('pure additions and removals keep both sides reconstructible', () => {
    for (const [before, after] of [
      ['a\nc', 'a\nb\nc'],
      ['a\nb\nc', 'a\nc'],
      ['', 'x\ny'],
      ['x\ny', ''],
      ['one\ntwo\nthree', 'zero\ntwo\nfour\nthree'],
    ] as const) {
      const rows = lineDiff(before, after);
      expect(rebuildBefore(rows)).toBe(before);
      expect(rebuildAfter(rows)).toBe(after);
    }
  });

  it('the huge-middle fallback is still a correct diff', () => {
    // > 250k LCS cells (600 × 600 unique lines) triggers the block fallback.
    const before = Array.from({ length: 600 }, (_, i) => `old-${i}`).join('\n');
    const after = Array.from({ length: 600 }, (_, i) => `new-${i}`).join('\n');
    const rows = lineDiff(`keep\n${before}\nkeep2`, `keep\n${after}\nkeep2`);
    expect(rebuildBefore(rows)).toBe(`keep\n${before}\nkeep2`);
    expect(rebuildAfter(rows)).toBe(`keep\n${after}\nkeep2`);
    expect(rows[0]).toEqual({ type: 'same', text: 'keep' });
    expect(rows[rows.length - 1]).toEqual({ type: 'same', text: 'keep2' });
  });
});
