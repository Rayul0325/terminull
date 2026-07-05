import { defineAdapter, type AgentAdapter } from '@terminull/adapter-sdk';

/** Adapter describing the Codex CLI. */
export const codexAdapter: AgentAdapter = defineAdapter({
  name: '@terminull/adapter-codex',
  version: '0.0.0',
  tool: 'codex',
  displayName: 'Codex',
});
