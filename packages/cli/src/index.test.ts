import { describe, expect, it } from 'vitest';
import { CLI_PLACEHOLDER } from './index';

describe('@terminull/cli', () => {
  it('exposes its package identity', () => {
    expect(CLI_PLACEHOLDER.name).toBe('@terminull/cli');
    expect(CLI_PLACEHOLDER.version).toBe('0.0.0');
  });
});
