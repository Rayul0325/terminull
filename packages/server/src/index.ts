/**
 * `@terminull/server` — the panel server: HTTP + WS API, permission gate,
 * paneld client, fleet collection, and boot discovery.
 */
export {
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_SPAWN_ALLOWLIST,
  TerminullServer,
  UnsafeBindError,
  createTerminullServer,
  defaultPluginHost,
  type ServerOptions,
} from './app.js';
export {
  ACTOR_HEADER,
  Auth,
  TOKEN_COOKIE,
  isLoopback,
  originOk,
  type AuthOptions,
  type RequestActor,
} from './auth.js';
export { ConfirmationQueue, type GateResult, type PendingConfirmation } from './confirmations.js';
export {
  DISCOVERY_FILE,
  readDiscovery,
  removeDiscovery,
  writeDiscovery,
  type ServerDiscovery,
} from './discovery.js';
export {
  collectFleet,
  type AdapterFleetStatus,
  type FleetSession,
  type FleetSnapshot,
} from './fleet.js';
export {
  HostRequestError,
  HostUnavailableError,
  PaneldClient,
  defaultPaneldBin,
  type HostExitInfo,
  type HostUpInfo,
  type PaneldClientOptions,
  type PtyAttachment,
} from './paneld-client.js';
export { SessionRegistry, type ServerSession, type SessionMeta } from './sessions.js';
