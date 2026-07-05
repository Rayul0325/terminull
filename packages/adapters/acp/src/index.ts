import { defineAdapter, type AgentAdapter } from '@terminull/adapter-sdk';

/** Adapter describing an ACP (Agent Client Protocol) speaking agent. */
export const acpAdapter: AgentAdapter = defineAdapter({
  name: '@terminull/adapter-acp',
  version: '0.0.0',
  tool: 'acp',
  displayName: 'ACP Agent',
});
