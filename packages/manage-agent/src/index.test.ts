import { describe, expect, it } from 'vitest';
import { MANAGE_AGENT_PLACEHOLDER } from './index';

describe('@terminull/manage-agent', () => {
  it('starts with no managed agents', () => {
    expect(MANAGE_AGENT_PLACEHOLDER.managed).toHaveLength(0);
    expect(MANAGE_AGENT_PLACEHOLDER.core.kind).toBe('core');
  });
});
