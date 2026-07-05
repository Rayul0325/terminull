import { describe, expect, it } from 'vitest';
import { claudeAdapter } from './index';

describe('@terminull/adapter-claude', () => {
  it('describes the claude tool', () => {
    expect(claudeAdapter.tool).toBe('claude');
    expect(claudeAdapter.displayName).toBe('Claude Code');
  });
});
