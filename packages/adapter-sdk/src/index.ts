import type { CoreInfo } from '@terminull/core';
import type { TerminullMeta } from '@terminull/shared';

/** The contract every CLI-tool adapter implements. */
export interface AgentAdapter extends TerminullMeta {
  /** Stable identifier of the CLI tool this adapter drives, e.g. "claude". */
  readonly tool: string;
  /** Human-readable label surfaced in the panel. */
  readonly displayName: string;
}

/** Runtime context handed to an adapter by the core layer. */
export interface AdapterContext {
  readonly core: CoreInfo;
}

/** Identity helper that pins an object literal to the {@link AgentAdapter} contract. */
export function defineAdapter<const T extends AgentAdapter>(adapter: T): T {
  return adapter;
}
