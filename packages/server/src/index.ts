import type { AgentAdapter } from '@terminull/adapter-sdk';
import { CORE_PLACEHOLDER, type CoreInfo } from '@terminull/core';

/** Placeholder describing the server's registered core and adapters. */
export interface ServerInfo {
  readonly core: CoreInfo;
  readonly adapters: readonly AgentAdapter[];
}

export const SERVER_PLACEHOLDER: ServerInfo = {
  core: CORE_PLACEHOLDER,
  adapters: [],
};
