import { describe, expect, it } from 'vitest';
import { SERVER_PLACEHOLDER } from './index';

describe('@terminull/server', () => {
  it('starts with no adapters registered', () => {
    expect(SERVER_PLACEHOLDER.adapters).toHaveLength(0);
    expect(SERVER_PLACEHOLDER.core.kind).toBe('core');
  });
});
