/**
 * Tool capabilities — the honest, per-adapter feature matrix.
 *
 * These describe what an integrated CLI tool can actually do, so the panel
 * never offers an affordance the tool cannot back. HONESTY RULE: anything an
 * adapter cannot verify defaults to the falsy/`'none'` variant.
 * {@link minimalCapabilities} produces that all-negative baseline; adapters
 * override only the fields they can prove.
 */

/** How live/running sessions can be detected. */
export type LiveDetection = 'pid-registry' | 'runtime-file' | 'mtime-heuristic' | 'none';
/** Transcript storage format the parser reads. */
export type TranscriptFormat = 'jsonl' | 'sqlite' | 'opaque' | 'none';
/** Headless (non-interactive) invocation style. */
export type HeadlessMode = 'stream-json' | 'exec-json' | 'oneshot' | 'none';
/** Co-drive channel — how an external controller feeds input alongside a human. */
export type CoDriveChannel = 'input-file' | 'json-fd' | 'app-server' | 'http-server' | 'none';
/** Hook richness the tool exposes. */
export type HookSupport = 'rich' | 'notify-only' | 'none';
/** How the set of available models is discovered. */
export type ModelDiscovery = 'dynamic' | 'configured' | 'none';
/** Slash-command discoverability. */
export type SlashCommandSupport = 'discoverable' | 'none';

/** Per-adapter account capabilities. All falsy unless verified. */
export interface AccountCapabilities {
  /** Can report the currently signed-in identity. */
  whoami: boolean;
  /** Can report usage / quota. */
  usage: boolean;
  /** Can enumerate configured profiles. */
  profiles: boolean;
  /** Can switch the active profile. */
  switch: boolean;
}

/**
 * The full capability matrix for one adapter. Consumers gate UI/behaviour on
 * these; adapters must not declare a capability they cannot honour.
 */
export interface ToolCapabilities {
  liveDetection: LiveDetection;
  transcript: TranscriptFormat;
  headless: HeadlessMode;
  /** Speaks the Agent Client Protocol. */
  acp: boolean;
  coDrive: CoDriveChannel;
  hooks: HookSupport;
  /** Permission-mode identifiers the tool understands (empty = none). */
  permissionModes: string[];
  modelDiscovery: ModelDiscovery;
  slashCommands: SlashCommandSupport;
  /** Sessions can be resumed. */
  resume: boolean;
  /** Sessions can be forked. */
  fork: boolean;
  accounts: AccountCapabilities;
  /** Exposes editable harness files. */
  harnessFiles: boolean;
}

/**
 * The all-negative baseline (honesty default). Pass `overrides` to raise only
 * the fields an adapter can actually prove. Returns a fresh object each call —
 * `permissionModes`/`accounts` are not shared across callers.
 */
export function minimalCapabilities(overrides?: Partial<ToolCapabilities>): ToolCapabilities {
  return {
    liveDetection: 'none',
    transcript: 'none',
    headless: 'none',
    acp: false,
    coDrive: 'none',
    hooks: 'none',
    permissionModes: [],
    modelDiscovery: 'none',
    slashCommands: 'none',
    resume: false,
    fork: false,
    accounts: { whoami: false, usage: false, profiles: false, switch: false },
    harnessFiles: false,
    ...overrides,
  };
}
