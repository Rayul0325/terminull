import { describe, expect, it } from 'vitest';
import { resolvePaneByPid } from '../src/tmux';

// A tmux `list-panes -a -F '#{pane_pid} #{pane_id}'` snapshot: three panes whose
// FOREGROUND processes are 100, 200, 300 in panes %1, %2, %3.
const PANES = ['100 %1', '200 %2', '300 %3'].join('\n');

function withPanes(raw: string): { listPanes: () => Promise<string> } {
  return { listPanes: () => Promise.resolve(raw) };
}

describe('resolvePaneByPid', () => {
  it('direct match: the pid IS a pane foreground process', async () => {
    const target = await resolvePaneByPid('tmux', 200, {
      ...withPanes(PANES),
      // Should never be consulted for a direct hit, but be safe.
      ppidOf: () => Promise.resolve(null),
    });
    expect(target).toBe('%2');
  });

  it('ancestor walk: a child process resolves to its pane via the parent chain', async () => {
    // 555 -> 400 -> 300(=pane %3). The first pane_pid on the chain wins.
    const parents: Record<number, number> = { 555: 400, 400: 300 };
    const target = await resolvePaneByPid('tmux', 555, {
      ...withPanes(PANES),
      ppidOf: (pid) => Promise.resolve(parents[pid] ?? null),
    });
    expect(target).toBe('%3');
  });

  it('returns null when the pid is not inside any tmux pane', async () => {
    const target = await resolvePaneByPid('tmux', 999, {
      ...withPanes(PANES),
      ppidOf: (pid) => Promise.resolve(pid === 999 ? 1 : null), // climbs to init, no pane
    });
    expect(target).toBeNull();
  });

  it('returns null (honest, no throw) when tmux list-panes fails', async () => {
    const target = await resolvePaneByPid('tmux', 200, {
      listPanes: () => Promise.reject(new Error('no server running')),
    });
    expect(target).toBeNull();
  });

  it('terminates on a parent cycle without hanging', async () => {
    // Pathological ppid cycle 700<->701, neither a pane — must return null.
    const parents: Record<number, number> = { 700: 701, 701: 700 };
    const target = await resolvePaneByPid('tmux', 700, {
      ...withPanes(PANES),
      ppidOf: (pid) => Promise.resolve(parents[pid] ?? null),
    });
    expect(target).toBeNull();
  });
});
