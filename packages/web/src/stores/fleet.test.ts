/**
 * Fleet machine-tagging selectors (M8): untagged sessions honestly belong to
 * 'local', tagged ones to their machine, and groupByMachine mirrors the cwd
 * grouping semantics. Pure selectors — no fetches, no stores touched.
 */
import { describe, expect, it } from 'vitest';
import type { FleetSession } from '../api/types';
import { groupByMachine, sessionMachineId } from './fleet';

function session(overrides: Partial<FleetSession> = {}): FleetSession {
  return { id: 's1', tool: 'claude-code', live: false, origin: 'adapter', ...overrides };
}

describe('fleet machine tagging', () => {
  it('sessionMachineId defaults to local and respects the tag', () => {
    expect(sessionMachineId(session())).toBe('local');
    expect(sessionMachineId(session({ machine: 'local' }))).toBe('local');
    expect(sessionMachineId(session({ machine: 'mars' }))).toBe('mars');
  });

  it('groupByMachine buckets tagged and untagged sessions correctly', () => {
    const sessions = [
      session({ id: 'a' }), // untagged -> local
      session({ id: 'b', machine: 'local' }),
      session({ id: 'c', machine: 'mars' }),
      session({ id: 'd', machine: 'mars' }),
    ];
    const groups = groupByMachine(sessions);
    expect([...groups.keys()].sort()).toEqual(['local', 'mars']);
    expect(groups.get('local')?.map((s) => s.id)).toEqual(['a', 'b']);
    expect(groups.get('mars')?.map((s) => s.id)).toEqual(['c', 'd']);
  });
});
