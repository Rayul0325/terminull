import { describe, expect, it } from 'vitest';
import { genericAdapter } from './index';

describe('@terminull/adapter-generic', () => {
  it('describes the generic tool', () => {
    expect(genericAdapter.tool).toBe('generic');
    expect(genericAdapter.displayName).toBe('Generic CLI');
  });
});
