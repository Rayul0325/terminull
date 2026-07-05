import { describe, expect, it } from 'vitest';
import { agyAdapter } from './index';

describe('@terminull/adapter-agy', () => {
  it('describes the agy tool', () => {
    expect(agyAdapter.tool).toBe('agy');
    expect(agyAdapter.displayName).toBe('agy');
  });
});
