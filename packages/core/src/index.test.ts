import { describe, expect, it } from 'vitest';
import { CORE_PLACEHOLDER } from './index';

describe('@terminull/core', () => {
  it('builds on the shared placeholder', () => {
    expect(CORE_PLACEHOLDER.kind).toBe('core');
    expect(CORE_PLACEHOLDER.version).toBe('0.0.0');
  });
});
