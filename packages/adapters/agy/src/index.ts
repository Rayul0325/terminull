/**
 * `@terminull/adapter-agy` — the Antigravity (`agy`) integration plugin.
 *
 * Replaces the legacy `defineAdapter` stub (M0) with a full {@link ToolAdapter}:
 * an honest "minimal-plus" capability matrix, an mtime-heuristic conversation
 * collector, a PTY fallback driver + keymap, a config-only model registry, a
 * Google-account provider, and harness files. It deliberately ships NO
 * transcript parser (opaque protobuf transcripts) and NO harness injector (agy
 * has no hooks). Exports the adapter factory (also the plugin-contract default),
 * every sub-piece factory, and the plugin manifest.
 */
export { createAgyAdapter, type AgyAdapterOptions } from './adapter.js';
export { default } from './adapter.js';

export {
  agyCapabilities,
  parsePermissionModes,
  AGY_PERMISSION_MODES,
  type PermissionModeResult,
  type PermissionModeSource,
} from './capabilities.js';
export { agyKeymap } from './keymap.js';
export { createAgyCollector, type AgyCollectorOptions } from './collector.js';
export { createAgyModelRegistry, type AgyModelRegistryOptions } from './models.js';
export { createAgyAccountProvider, maskEmailUser, type AgyAccountOptions } from './accounts.js';
export {
  AgyPtyDriver,
  buildAgyOneshotCommand,
  type AgyOneshotOptions,
  type AgyOneshotCommand,
} from './driver.js';
export { agyHarnessFiles } from './harness-files.js';
export { manifest } from './manifest.js';
