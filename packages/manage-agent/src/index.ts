import type { AgentAdapter } from '@terminull/adapter-sdk';
import { CORE_PLACEHOLDER, type CoreInfo } from '@terminull/core';

/** Lifecycle states a managed agent process can be in. */
export type AgentLifecycle = 'idle' | 'starting' | 'running' | 'stopped';

/** A single agent tracked by the manager. */
export interface ManagedAgent {
  readonly adapter: AgentAdapter;
  readonly lifecycle: AgentLifecycle;
}

/** Placeholder describing the manager's core link and tracked agents. */
export interface ManageAgentInfo {
  readonly core: CoreInfo;
  readonly managed: readonly ManagedAgent[];
}

export const MANAGE_AGENT_PLACEHOLDER: ManageAgentInfo = {
  core: CORE_PLACEHOLDER,
  managed: [],
};
