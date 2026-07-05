import { defineAdapter, type AgentAdapter } from '@terminull/adapter-sdk';

/** Fallback adapter for a generic CLI tool with no dedicated integration. */
export const genericAdapter: AgentAdapter = defineAdapter({
  name: '@terminull/adapter-generic',
  version: '0.0.0',
  tool: 'generic',
  displayName: 'Generic CLI',
});
