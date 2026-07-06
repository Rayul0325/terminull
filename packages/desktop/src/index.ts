/**
 * `@terminull/desktop` public surface — the PURE, electron-free modules of the
 * thin shell (decision logic, loopback policy, discovery mirror, screens). The
 * electron entry itself is `./main.js` (package `main`), which imports these;
 * it is NOT re-exported here because importing it pulls in `electron` (a runtime
 * only present inside the electron process).
 */
export {
  defaultStateDir,
  liveServer,
  pidAlive,
  readDiscovery,
  type ServerDiscovery,
} from './discovery.js';
export {
  decideMode,
  pollForServer,
  resolvePanelUrl,
  resolveServeCommand,
  ServerStartTimeout,
  type DecideDeps,
  type PollDeps,
  type ServeCommand,
  type ShellMode,
} from './mode.js';
export { isAllowedPopout, isBlockedResource, isNavigationAllowed } from './popout.js';
export { dataUrl, SCREENS, screenHtml } from './screens.js';
export { isLoopbackHostname, isLoopbackUrl, panelOrigin, parseUrlSafe } from './urls.js';
