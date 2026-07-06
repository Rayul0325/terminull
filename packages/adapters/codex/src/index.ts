/**
 * `@terminull/adapter-codex` — the Codex CLI deep-integration plugin.
 *
 * Replaces the legacy `defineAdapter` stub (M0) with a full {@link ToolAdapter}:
 * capabilities, index+rollout collector (SQLite `threads` enrichment), rollout
 * transcript parser, dual-channel driver (headless `codex exec --json` + PTY),
 * config.toml notify injector, model registry, account provider, and harness
 * files. Exports the adapter factory (also the plugin-contract default), every
 * sub-piece factory, and the plugin manifest.
 */
export { createCodexAdapter, type CodexAdapterOptions } from './adapter.js';
export { default } from './adapter.js';

export {
  codexCapabilities,
  parsePermissionModes,
  BUILTIN_PERMISSION_MODES,
  type PermissionModeResult,
  type PermissionModeSource,
} from './capabilities.js';
export { codexKeymap } from './keymap.js';
export {
  CodexTranscriptParser,
  type ByteCursor,
  type CodexTranscriptWindow,
  type CodexItemSemantic,
  type CodexParserOptions,
} from './parser.js';
export {
  createCodexCollector,
  listRollouts,
  type CodexCollectorOptions,
  type CodexSessionCollector,
  type CodexSessionDetail,
  type ThreadEnrichment,
  type RolloutHit,
} from './collector.js';
export {
  createCodexModelRegistry,
  parseConfiguredModels,
  type CodexModelRegistryOptions,
} from './models.js';
export {
  createCodexAccountProvider,
  codexAuthPresence,
  type CodexAccountOptions,
  type CodexAccountProvider,
  type CodexAuthPresence,
  type CodexUsageInfo,
  type CodexUsageWindow,
} from './usage.js';
export {
  CodexPtyDriver,
  CodexHeadlessRunner,
  buildExecArgs,
  type CodexHeadlessOptions,
  type CodexHeadlessResult,
  type CodexExecEvent,
  type SpawnFn,
} from './driver.js';
export {
  CodexNotifyInjector,
  patchNotify,
  unpatchNotify,
  NOTIFY_SCRIPT,
  type CodexNotifyInjectorOptions,
  type CodexHarnessPlan,
} from './injector.js';
export { codexHarnessFiles } from './harness-files.js';
export { manifest } from './manifest.js';
