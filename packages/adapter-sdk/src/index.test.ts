import { describe, expect, it } from 'vitest';
import { defineAdapter } from './index';

describe('@terminull/adapter-sdk', () => {
  it('pins an object to the adapter contract', () => {
    const adapter = defineAdapter({
      name: '@terminull/adapter-sdk',
      version: '0.0.0',
      tool: 'example',
      displayName: 'Example',
    });
    expect(adapter.tool).toBe('example');
    expect(adapter.displayName).toBe('Example');
  });
});
