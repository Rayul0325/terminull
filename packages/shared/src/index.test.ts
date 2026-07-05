import { describe, expect, it } from 'vitest';
import { SHARED_PLACEHOLDER } from './index';

describe('@terminull/shared', () => {
  it('exposes a typed placeholder', () => {
    expect(SHARED_PLACEHOLDER.name).toBe('@terminull/shared');
    expect(SHARED_PLACEHOLDER.version).toBe('0.0.0');
  });
});
