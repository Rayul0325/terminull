import { describe, expect, it } from 'vitest';
import { SESSION_HOST_PLACEHOLDER } from './index';

describe('@terminull/session-host', () => {
  it('declares node-pty but is not wired to it yet', () => {
    expect(SESSION_HOST_PLACEHOLDER.ptyBackend).toBe('node-pty');
    expect(SESSION_HOST_PLACEHOLDER.wired).toBe(false);
  });
});
