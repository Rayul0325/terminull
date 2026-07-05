import { defineAdapter, type AgentAdapter } from '@terminull/adapter-sdk';

/** Adapter describing the Claude Code CLI. */
export const claudeAdapter: AgentAdapter = defineAdapter({
  name: '@terminull/adapter-claude',
  version: '0.0.0',
  tool: 'claude',
  displayName: 'Claude Code',
});
