import { defineAdapter, type AgentAdapter } from '@terminull/adapter-sdk';

/** Adapter describing the agy CLI. */
export const agyAdapter: AgentAdapter = defineAdapter({
  name: '@terminull/adapter-agy',
  version: '0.0.0',
  tool: 'agy',
  displayName: 'agy',
});
