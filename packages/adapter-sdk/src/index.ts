import type { CoreInfo } from '@terminull/core';
import type { TerminullMeta } from '@terminull/shared';

// M3 adapter SDK: capability matrix, the ToolAdapter contract + sub-interfaces,
// the plugin runtime, and the conformance runner.
export * from './capabilities.js';
export * from './adapter.js';
export * from './plugin-host.js';
export * from './conformance.js';

/**
 * Legacy lightweight adapter descriptor (M0). Retained for the built-in adapter
 * stubs (acp/agy/claude/codex) that predate the full {@link ToolAdapter}
 * contract; new integrations implement `ToolAdapter` from `./adapter.js`.
 */
export interface AgentAdapter extends TerminullMeta {
  /** Stable identifier of the CLI tool this adapter drives, e.g. "claude". */
  readonly tool: string;
  /** Human-readable label surfaced in the panel. */
  readonly displayName: string;
}

/** Runtime context handed to a legacy adapter by the core layer. */
export interface AdapterContext {
  readonly core: CoreInfo;
}

/** Identity helper that pins an object literal to the {@link AgentAdapter} contract. */
export function defineAdapter<const T extends AgentAdapter>(adapter: T): T {
  return adapter;
}
