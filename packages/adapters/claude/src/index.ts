/**
 * `@terminull/adapter-claude` — the Claude Code deep-integration plugin.
 *
 * Replaces the legacy `defineAdapter` stub (M0) with a full {@link ToolAdapter}:
 * capabilities, collector, transcript parser, PTY driver + keymap, harness
 * injector, model registry, account provider, and harness files. Exports the
 * adapter factory (also the plugin-contract default), every sub-piece factory,
 * and the plugin manifest.
 */
export { createClaudeAdapter, type ClaudeAdapterOptions } from './adapter.js';
export { default } from './adapter.js';

export {
  claudeCapabilities,
  parsePermissionModes,
  BUILTIN_PERMISSION_MODES,
  type PermissionModeResult,
  type PermissionModeSource,
} from './capabilities.js';
export { claudeKeymap, RIGHT_BYTES, SHIFTTAB_PRIME_DELAY_MS } from './keymap.js';
export {
  ClaudeTranscriptParser,
  type ByteCursor,
  type ClaudeTranscriptWindow,
  type ClaudeItemSemantic,
  type ClaudeParserOptions,
} from './parser.js';
export { createClaudeCollector, type ClaudeCollectorOptions } from './collector.js';
export { createClaudeModelRegistry, type ClaudeModelRegistryOptions } from './models.js';
export {
  createClaudeAccountProvider,
  WHOAMI_ALLOWLIST,
  type ClaudeAccountOptions,
} from './accounts.js';
export {
  ClaudeDriver,
  MenuNotDismissedError,
  parseMenu,
  SHIFT_TAB_CYCLE,
  type ClaudeDriverOptions,
  type ClaudeAnswerMenuOptions,
  type SnapshotFn,
} from './driver.js';
export {
  ClaudeHarnessInjector,
  HOOK_SPECS,
  type HookSpec,
  type HarnessPlan,
  type ClaudeHarnessInjectorOptions,
} from './injector.js';
export { claudeHarnessFiles } from './harness-files.js';
export {
  parseStatusLine,
  type StatusLineInput,
  type StatusLineModel,
  type StatusLineWorkspace,
  type StatusLineRepo,
  type StatusLineCost,
  type StatusLineContextWindow,
  type StatusLineCurrentUsage,
  type StatusLineRateLimits,
  type StatusLinePr,
  type StatusLineWorktree,
} from './statusline.js';
export { manifest } from './manifest.js';
