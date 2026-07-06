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
  remoteCollectedToFleet,
  remotePaneldFleetSessions,
  unreachableStatus,
  type AdapterFleetStatus,
  type FleetSession,
  type FleetSnapshot,
} from './fleet.js';
export {
  MachineManager,
  MachineUnavailableError,
  UnknownMachineError,
  loadMachinesFile,
  saveMachinesFile,
  type MachineManagerOptions,
} from './machines.js';
export { registerMachinesRoutes, type MachinesRouteDeps } from './machines-routes.js';
export {
  HostConnection,
  HostRequestError,
  HostUnavailableError,
  PaneldClient,
  defaultPaneldBin,
  type HostConnectionOptions,
  type HostExitInfo,
  type HostUpInfo,
  type PaneldClientOptions,
  type PtyAttachment,
} from './paneld-client.js';
export {
  StdioProcessTransport,
  TransportDialError,
  UnixSocketTransport,
  transportForSpec,
  type FrameStream,
  type FrameTransport,
} from './transport.js';
export { SessionRegistry, type ServerSession, type SessionMeta } from './sessions.js';
