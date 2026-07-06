/**
 * Client-side line diff for the harness editor's save preview (M9 W2). Pure
 * and dependency-free: common prefix/suffix are trimmed first, the changed
 * middle gets an LCS alignment when small enough, and degrades to an honest
 * del-block + add-block for very large middles (still a CORRECT diff — just
 * not minimal; the preview never lies about what changes, it only aligns
 * less prettily).
 */

export interface DiffRow {
  type: 'same' | 'add' | 'del';
  text: string;
}

/** Above this LCS table size the middle degrades to del+add blocks. */
const LCS_CELL_CAP = 250_000;

function splitLines(text: string): string[] {
  return text === '' ? [] : text.split('\n');
}

/** LCS-aligned rows for two (small) line arrays. */
function lcsRows(a: string[], b: string[]): DiffRow[] {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i:] / b[j:]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ type: 'same', text: a[i]! });
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      rows.push({ type: 'del', text: a[i]! });
      i += 1;
    } else {
      rows.push({ type: 'add', text: b[j]! });
      j += 1;
    }
  }
  for (; i < n; i += 1) rows.push({ type: 'del', text: a[i]! });
  for (; j < m; j += 1) rows.push({ type: 'add', text: b[j]! });
  return rows;
}

/** Line diff of `before` → `after`. Empty array = no change. */
export function lineDiff(before: string, after: string): DiffRow[] {
  if (before === after) return [];
  const a = splitLines(before);
  const b = splitLines(after);
  // Trim the common prefix.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  // Trim the common suffix (never past the prefix).
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const middle: DiffRow[] =
    midA.length * midB.length <= LCS_CELL_CAP
      ? lcsRows(midA, midB)
      : [
          ...midA.map((text): DiffRow => ({ type: 'del', text })),
          ...midB.map((text): DiffRow => ({ type: 'add', text })),
        ];
  return [
    ...a.slice(0, start).map((text): DiffRow => ({ type: 'same', text })),
    ...middle,
    ...a.slice(endA).map((text): DiffRow => ({ type: 'same', text })),
  ];
}

/** Changed-row counts for a compact "+" / "−" summary chip. */
export function diffStats(rows: DiffRow[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    if (row.type === 'add') added += 1;
    else if (row.type === 'del') removed += 1;
  }
  return { added, removed };
}
