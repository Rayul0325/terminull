/**
 * The `ToolAdapter` contract and every sub-interface a CLI-tool integration
 * implements. Adapters are pure declarations + factories: they describe what a
 * tool can do and how to drive it, but NEVER perform core-privileged work
 * (event append, file writes) themselves — those stay in `@terminull/core`.
 *
 * Decoupling: an adapter's {@link Driver} composes with a caller-supplied
 * {@link KeyInjector} (the session-host IN channel). This SDK never imports the
 * session-host; the wiring is injected, so the SDK stays a leaf dependency.
 */
import type { LocalizedText } from '@terminull/shared';
import type { ToolCapabilities } from './capabilities.js';

/** Coarse risk band for a key/action, surfaced in the UI before it fires. */
export type RiskLevel = 'low' | 'med' | 'high';

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

/** Context handed to {@link ToolAdapter.probe}. */
export interface ProbeContext {
  /** The configured command/binary to probe for (adapter-specific). */
  cmd?: string;
  /** User home dir, when the probe needs it. */
  home?: string;
  /** Working directory, when the probe needs it. */
  cwd?: string;
  /**
   * Resolver returning a binary's absolute path, or null when absent. Injected
   * so probing is testable and the SDK never shells out on its own; when
   * omitted an adapter may fall back to a real PATH lookup.
   */
  which?: (cmd: string) => Promise<string | null> | string | null;
}

/** Result of probing for a tool's presence + runtime-verified capabilities. */
export interface ProbeResult {
  /** The tool is present and usable. */
  present: boolean;
  /** Detected version string, when known. */
  version?: string;
  /**
   * Capabilities the probe could ACTUALLY verify at runtime. Partial: a field
   * left out means "not observed", not "unavailable". The conformance runner
   * fails any declared capability the probe positively reports as unavailable.
   */
  capabilities: Partial<ToolCapabilities>;
  /** Human-readable diagnostic (en+ko). */
  detail?: LocalizedText;
}

// ---------------------------------------------------------------------------
// Session discovery + transcript
// ---------------------------------------------------------------------------

/** A handle the parser uses to read a session's transcript. */
export type TranscriptRef =
  | { kind: 'file'; path: string }
  | { kind: 'sqlite'; path: string }
  | { kind: 'opaque'; handle: string };

/** Context handed to {@link SessionCollector.collect}. */
export interface CollectContext {
  home?: string;
  cwd?: string;
  /** Epoch ms treated as "now" (injected for deterministic tests). */
  now?: number;
}

/** One discovered session, tool-native. `live` is false whenever unverifiable. */
export interface DiscoveredSession {
  /** Adapter-unique, tool-native session id. */
  id: string;
  /** Owning tool/adapter id. */
  tool: string;
  /** Working directory, when known. */
  cwd?: string;
  /** Best-effort liveness; MUST be false when it cannot be verified (honesty). */
  live: boolean;
  /** Short human title/summary. */
  title?: string;
  /** Epoch ms of last activity, when known. */
  updatedAt?: number;
  /**
   * Live OS pid of the session process, when known. Lets the server resolve the
   * tmux pane a discovered (non-paneld-owned) session runs in, so a GUI
   * directive can be delivered via `tmux send-keys`. Absent = not resolvable
   * (never guessed).
   */
  pid?: number;
  /** How to read this session's transcript, when available. */
  transcriptRef?: TranscriptRef;
}

/** A value that may be sync or async. */
export type Awaitable<T> = T | Promise<T>;

/** Discovers a tool's sessions from disk/registry. */
export interface SessionCollector {
  /** Enumerate sessions. Returns `[]` for tools that are not discoverable. */
  collect(ctx: CollectContext): Awaitable<DiscoveredSession[]>;
  /** Filesystem paths worth watching for change-driven refresh. */
  watchPaths?(ctx: CollectContext): string[];
}

/** Opaque, monotonic cursor into a transcript. */
export interface TranscriptCursor {
  /** Non-negative position; never moves backward across a read. */
  offset: number;
}

/**
 * A normalised transcript entry the UI renders.
 *
 * `kind` is additive across adapters: the base set is `message` / `tool_call` /
 * `tool_result` / `event`. The claude adapter (2026-07-06 parity extension) adds
 * `reasoning` (thinking blocks), `sidechain` (a bounded subagent-thread marker),
 * and `system` (system/summary/compaction records, subtype carried in `raw`).
 * Members are ONLY ever added, never removed or repurposed, so an adapter that
 * emits a narrower set stays valid; renderers treat any unknown kind as a
 * generic event.
 */
export interface ChatItem {
  id: string;
  role: 'user' | 'agent' | 'tool' | 'system';
  kind: 'message' | 'tool_call' | 'tool_result' | 'event' | 'reasoning' | 'sidechain' | 'system';
  text?: string;
  ts?: number;
  /** Original tool-native record, kept for renderers that need more. */
  raw?: unknown;
}

/** One window of transcript, plus the cursor to continue from. */
export interface TranscriptWindow {
  items: ChatItem[];
  /** Cursor for the next call; `offset` is monotonic w.r.t. the input cursor. */
  cursor: TranscriptCursor;
  /** True when no items remain past this window. */
  done: boolean;
}

/** Reads a session's transcript in monotonic windows. */
export interface TranscriptParser {
  readWindow(ref: TranscriptRef, cursor?: TranscriptCursor): Awaitable<TranscriptWindow>;
}

// ---------------------------------------------------------------------------
// Keymap
// ---------------------------------------------------------------------------

/** Symbolic key names a driver understands. */
export type NamedKey =
  | 'Enter'
  | 'Escape'
  | 'Tab'
  | 'ShiftTab'
  | 'Up'
  | 'Down'
  | 'Left'
  | 'Right'
  | 'Home'
  | 'End'
  | 'PageUp'
  | 'PageDown'
  | 'Backspace'
  | 'Space'
  | 'CtrlA'
  | 'CtrlB'
  | 'CtrlC'
  | 'CtrlD'
  | 'CtrlU';

/** One key binding: the raw bytes to emit plus display/safety metadata. */
export interface KeyBinding {
  /** Byte sequence written to the PTY when this key fires. Never empty. */
  bytes: Uint8Array;
  /** tmux key name (for `send-keys`), when applicable. */
  tmuxName?: string;
  /** Known quirks (e.g. "tmux prefix collision"). */
  quirks?: string[];
  /** Display label (en+ko). */
  label: LocalizedText;
  /** Risk band, shown before firing. */
  risk: RiskLevel;
}

/** A named-key → binding table. Sparse: a tool binds only what it supports. */
export type Keymap = Partial<Record<NamedKey, KeyBinding>>;

// ---------------------------------------------------------------------------
// Driver + prompt state
// ---------------------------------------------------------------------------

/** One selectable option within a menu prompt. */
export interface MenuOption {
  /** Zero-based position as it appears on screen. */
  index: number;
  /** Visible label. */
  label: string;
  /** Underlying value, when distinct from the label. */
  value?: string;
  /** Currently highlighted/selected (for multi-select menus). */
  selected?: boolean;
}

/** Coarse menu classification (extensible per tool). */
export type MenuType = 'select' | 'permission' | 'plan' | 'confirm' | (string & {});

/**
 * The interactive state of a session's prompt, derived from a screen snapshot.
 * `unknown` is the honest default when a tool's prompt cannot be classified.
 */
export type PromptState =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'menu'; menuType: MenuType; options: MenuOption[]; multiSelect?: boolean }
  | { kind: 'unknown' };

/** The IN channel a driver writes to (the session-host input side). */
export type KeyInjector = (bytes: Uint8Array) => void | Promise<void>;

/** Wiring handed to {@link ToolAdapter.driverFor} to build a live driver. */
export interface DriveContext {
  /** Sink for raw bytes → the session-host IN channel. */
  inject: KeyInjector;
}

/** Options for {@link Driver.sendText}. */
export interface SendTextOptions {
  text: string;
  /** Press submit (Enter) after typing. Default false. */
  submit?: boolean;
}

/** Options for {@link Driver.answerMenu}. */
export interface AnswerMenuOptions {
  /** Current screen snapshot — verified against before any keystroke. */
  screen: string;
  /** Option index to choose (array for multi-select). */
  choice: number | number[];
  /** Whether the target menu is multi-select. */
  multiSelect?: boolean;
}

/** Drives a live session: typing, keys, menu answers, mode changes. */
export interface Driver {
  sendText(opts: SendTextOptions): Promise<void>;
  sendKey(key: NamedKey): Promise<void>;
  /**
   * Answer a menu SAFELY: verify the prompt is actually a menu (from `screen`)
   * BEFORE emitting keys, then re-check. Rejects with {@link MenuNotPresentError}
   * when the prompt is not a menu — never fires blind keystrokes.
   */
  answerMenu(opts: AnswerMenuOptions): Promise<void>;
  approvePlan(screen: string): Promise<void>;
  setPermissionMode(mode: string, screen: string): Promise<void>;
  interrupt(): Promise<void>;
  background(): Promise<void>;
  rename(title: string): Promise<void>;
  /** Classify the prompt from a screen snapshot (pure, no side effects). */
  detectPromptState(screen: string): PromptState;
}

// ---------------------------------------------------------------------------
// Harness injection + models + accounts + harness files
// ---------------------------------------------------------------------------

/** Context handed to {@link HarnessInjector} / harness-file resolvers. */
export interface HarnessContext {
  home?: string;
  cwd?: string;
}

/** Result of a harness-injector operation. */
export interface HarnessStatus {
  installed: boolean;
  /** Human detail (en+ko), e.g. why install failed. */
  detail?: LocalizedText;
}

/** Installs/removes the panel's hook harness into a tool. */
export interface HarnessInjector {
  status(ctx: HarnessContext): Promise<HarnessStatus>;
  install(ctx: HarnessContext): Promise<HarnessStatus>;
  uninstall(ctx: HarnessContext): Promise<HarnessStatus>;
  verify(ctx: HarnessContext): Promise<HarnessStatus>;
}

/** One selectable model. */
export interface ModelInfo {
  id: string;
  label: string;
  /** Where this entry came from — honesty about provenance. */
  source: 'discovered' | 'configured' | 'fallback';
}

/** Enumerates the models a tool can use. */
export interface ModelRegistry {
  list(ctx?: HarnessContext): Awaitable<ModelInfo[]>;
}

/**
 * An account operation's result: either a value, or an honest "unavailable"
 * carrying a reason. Adapters NEVER fabricate an identity/usage they cannot
 * read.
 */
export type AccountResult<T> =
  { available: true; value: T } | { available: false; reason: LocalizedText };

/** The signed-in identity. */
export interface WhoamiInfo {
  account: string;
  plan?: string;
}

/** Usage / quota snapshot. */
export interface UsageInfo {
  label: LocalizedText;
  used?: number;
  limit?: number;
}

/** One configurable account profile. */
export interface AccountProfile {
  id: string;
  label: string;
  active: boolean;
}

/** Reads/switches a tool's accounts, always honest about unavailability. */
export interface AccountProvider {
  whoami(ctx?: HarnessContext): Promise<AccountResult<WhoamiInfo>>;
  usage(ctx?: HarnessContext): Promise<AccountResult<UsageInfo>>;
  listProfiles(ctx?: HarnessContext): Promise<AccountResult<AccountProfile[]>>;
  switchProfile(id: string, ctx?: HarnessContext): Promise<AccountResult<AccountProfile>>;
}

/** Storage/edit format of a harness file. */
export type HarnessFileFormat = 'markdown' | 'json' | 'yaml' | 'toml' | 'text' | 'other';
/** Where a harness file lives. */
export type HarnessFileScope = 'user' | 'project' | 'session' | 'machine';

/** Describes one editable harness file the panel can surface. */
export interface HarnessFileSpec {
  id: string;
  /** Display label (en+ko). */
  label: LocalizedText;
  /** What this file controls (en+ko). */
  description: LocalizedText;
  format: HarnessFileFormat;
  scope: HarnessFileScope;
  riskLevel: RiskLevel;
  /** Fixed path, OR resolve one from context (mutually complementary). */
  path?: string;
  pathResolver?: (ctx: HarnessContext) => string;
  /** True when absence is normal (not an error). */
  mayNotExist?: boolean;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

/** The contract every CLI-tool adapter implements. */
export interface ToolAdapter {
  /** Stable adapter id (matches its {@link AdapterContribution} id). */
  id: string;
  /** Display label (en+ko). */
  displayName: LocalizedText;
  probe(ctx: ProbeContext): Promise<ProbeResult>;
  /** DECLARED capability matrix (verified subset returned by {@link probe}). */
  capabilities: ToolCapabilities;
  collector: SessionCollector;
  parser?: TranscriptParser;
  /**
   * Build a live driver for a session, wired to the caller's injector, or null
   * when the session is not drivable. Note: the plan's `driverFor(session)`
   * shorthand is extended with a {@link DriveContext} so the driver can compose
   * with the (decoupled) session-host IN channel without the SDK importing it.
   */
  driverFor(session: DiscoveredSession, ctx: DriveContext): Driver | null;
  keymap: Keymap;
  injector?: HarnessInjector;
  models: ModelRegistry;
  accounts?: AccountProvider;
  harnessFiles?: HarnessFileSpec[];
  /**
   * Env var names that point this tool at an ISOLATED config home (account
   * profiles, M9). At spawn time the server sets each listed var to the active
   * profile's `configHome` (an absolute path) — for NEW spawns only; live
   * sessions are never touched and credentials are never copied between homes.
   * Examples: claude `['CLAUDE_CONFIG_DIR']`, codex `['CODEX_HOME']`.
   * Absent/empty = the tool cannot be profile-isolated (the server refuses
   * non-default profiles for it with a typed 422 — honesty, no silent default).
   */
  configHomeEnvVars?: readonly string[];
  /**
   * Deliver a GUI directive to a DISCOVERED (non-paneld-owned) session using
   * this tool's OWN mechanism, when the generic pid→tmux path cannot reach it.
   * Codex implements this (app-server `turn/start` keyed on the session id =
   * rollout uuid = threadId — no pane/pid join needed); tools with a live pid
   * registry (Claude) leave it undefined and are served by the core tmux path.
   * Resolves to `'delivered'` only on real acceptance; `'unsupported'` → the
   * caller queues honestly and NEVER fabricates a delivery. Local sessions only.
   */
  deliverDirectiveToDiscovered?(
    session: DiscoveredSession,
    text: string,
  ): Promise<'delivered' | 'unsupported'>;
}

/**
 * Whether a tool is drivable at all: it exposes at least one key binding, or a
 * co-drive channel. Used by the conformance runner to require a driver iff the
 * capabilities imply one.
 */
export function isDrivable(capabilities: ToolCapabilities, keymap: Keymap): boolean {
  return Object.keys(keymap).length > 0 || capabilities.coDrive !== 'none';
}

// ---------------------------------------------------------------------------
// Typed driver errors
// ---------------------------------------------------------------------------

/** Thrown by {@link Driver.answerMenu}/approvePlan when the prompt is not a menu. */
export class MenuNotPresentError extends Error {
  readonly code = 'MENU_NOT_PRESENT';
  constructor(
    /** The prompt state observed instead of a menu. */
    readonly observed: PromptState['kind'],
  ) {
    super(`menu not present: prompt state is '${observed}', refusing blind keystrokes`);
    this.name = 'MenuNotPresentError';
  }
}

/** Thrown when a driver is asked for a {@link NamedKey} it does not bind. */
export class UnknownKeyError extends Error {
  readonly code = 'UNKNOWN_KEY';
  constructor(readonly key: string) {
    super(`no binding for key '${key}' in this keymap`);
    this.name = 'UnknownKeyError';
  }
}

/** Thrown when a driver operation is not supported by the underlying tool. */
export class AdapterUnsupportedError extends Error {
  readonly code = 'ADAPTER_UNSUPPORTED';
  constructor(readonly operation: string) {
    super(`operation '${operation}' is not supported by this adapter`);
    this.name = 'AdapterUnsupportedError';
  }
}
