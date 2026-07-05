import { describe, expect, it } from 'vitest';
import { acpAdapter } from './index';

describe('@terminull/adapter-acp', () => {
  it('describes the acp tool', () => {
    expect(acpAdapter.tool).toBe('acp');
    expect(acpAdapter.displayName).toBe('ACP Agent');
  });
});
