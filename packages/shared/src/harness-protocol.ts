/**
 * Harness-editor wire contract (M9) — the REST shapes for reading/editing a
 * tool's harness files (CLAUDE.md, settings.json, config.toml, …), listing and
 * restoring backups, surfacing the read-only "내 커스텀" (my custom) detection
 * group, the per-session GUI statusbar DTO, and server-persisted UI keybinding
 * overrides.
 *
 * Ground rules pinned here (violations are contract bugs, not preferences):
 *  - The WRITE PIPELINE is core-owned: jail → format-parse validation → sha
 *    optimistic lock (409) → backup rotation (20) → atomic write → audit event.
 *    Diffs/content are NEVER persisted in the event log — only shas + sizes.
 *  - A parse-invalid save is a 422 carrying the parse error detail, never a
 *    silent write. A stale `expectedSha` is a 409 carrying the current sha.
 *  - Custom-harness DETECTION of the real home is READ-ONLY; credential files
 *    (auth.json, .credentials.json, token stores) are never opened.
 *  - Statusbar numbers come from the same data the claude statusline stdin
 *    gets; anything the source did not report is an honest `null`, never 0.
 */
import { z } from 'zod';
import { LocalizedTextSchema } from './plugin-api.js';

// ---------------------------------------------------------------------------
// Harness file manifest — GET /api/harness/files
// ---------------------------------------------------------------------------

/**
 * Storage/edit format of a harness file. Mirrors the adapter-sdk
 * `HarnessFileFormat` union VALUE-FOR-VALUE (shared cannot import the SDK —
 * the SDK depends on shared). The conformance point is the server, which
 * assigns `HarnessFileSpec.format` straight into this field.
 */
export const HARNESS_FILE_FORMATS = [
  'markdown',
  'json',
  'yaml',
  'toml',
  'text',
  'other',
] as const;
export type HarnessFileFormatDto = (typeof HARNESS_FILE_FORMATS)[number];

/** Where a harness file lives (mirrors adapter-sdk `HarnessFileScope`). */
export const HARNESS_FILE_SCOPES = ['user', 'project', 'session', 'machine'] as const;
export type HarnessFileScopeDto = (typeof HARNESS_FILE_SCOPES)[number];

/** Coarse risk band (mirrors adapter-sdk `RiskLevel`). */
export const HARNESS_RISK_LEVELS = ['low', 'med', 'high'] as const;
export type HarnessRiskLevelDto = (typeof HARNESS_RISK_LEVELS)[number];

/**
 * Catalog file-id rule. Ids come from adapter catalogs (`claude.settings`,
 * `codex.config`, …) and are used as backup DIRECTORY names — the regex is a
 * defence-in-depth jail on top of catalog membership (no `/`, no `..`).
 */
export const HARNESS_FILE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** sha256 hex digest shape used by the optimistic lock. */
export const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/** Hard cap on editable harness-file size (read refusal + write refusal). */
export const HARNESS_MAX_CONTENT_BYTES = 1024 * 1024;

/** How many backups are kept per file (oldest rotated out). */
export const HARNESS_BACKUP_ROTATION = 20;

/** One manifest entry: an editable harness file the panel can surface. */
export const HarnessFileDtoSchema = z
  .object({
    id: z.string().regex(HARNESS_FILE_ID_RE),
    toolId: z.string().min(1),
    label: LocalizedTextSchema,
    description: LocalizedTextSchema,
    format: z.enum(HARNESS_FILE_FORMATS),
    scope: z.enum(HARNESS_FILE_SCOPES),
    riskLevel: z.enum(HARNESS_RISK_LEVELS),
    /** Resolved absolute path (absent when the resolver failed — honest). */
    path: z.string().min(1).optional(),
    /** Whether the file currently exists (absent when `path` is absent). */
    exists: z.boolean().optional(),
    /** True when absence is normal (not an error). */
    mayNotExist: z.boolean().optional(),
    /**
     * True for directory-shaped specs (format `other`, e.g. the skills dir):
     * listed for orientation, but GET/PUT refuse with `directory_not_editable`.
     */
    directory: z.boolean().optional(),
  })
  .strict();
export type HarnessFileDto = z.infer<typeof HarnessFileDtoSchema>;

/** One per-tool manifest group (`GET /api/harness/files` → `{groups}`). */
export const HarnessGroupDtoSchema = z
  .object({
    toolId: z.string().min(1),
    displayName: LocalizedTextSchema,
    files: z.array(HarnessFileDtoSchema),
  })
  .strict();
export type HarnessGroupDto = z.infer<typeof HarnessGroupDtoSchema>;

// ---------------------------------------------------------------------------
// Read / write / backups — GET|PUT /api/harness/files/:fileId (+/backups)
// ---------------------------------------------------------------------------

/**
 * Read response. A missing-but-allowed file is `exists:false` with null
 * content/sha — the editor renders an empty buffer and the subsequent save
 * sends `expectedSha: null` ("create; fail if someone created it first").
 */
export const HarnessReadDtoSchema = z
  .object({
    fileId: z.string().regex(HARNESS_FILE_ID_RE),
    toolId: z.string().min(1),
    path: z.string().min(1),
    exists: z.boolean(),
    content: z.string().nullable(),
    /** sha256 hex of the exact bytes returned in `content`; null when absent. */
    sha: z.string().regex(SHA256_HEX_RE).nullable(),
    /** Byte size on disk; null when absent. */
    size: z.number().int().nonnegative().nullable(),
    /** Epoch ms mtime; null when absent. */
    mtime: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type HarnessReadDto = z.infer<typeof HarnessReadDtoSchema>;

/**
 * Write request. `expectedSha` is the optimistic lock: the sha the client last
 * READ (null = "the file must not exist yet"). Mismatch → 409 `sha_mismatch`
 * with `currentSha`; parse-invalid content → 422 `parse_invalid` with the
 * parser's message — never a silent write.
 */
export const HarnessWriteRequestSchema = z
  .object({
    expectedSha: z.string().regex(SHA256_HEX_RE).nullable(),
    content: z.string().max(HARNESS_MAX_CONTENT_BYTES),
  })
  .strict();
export type HarnessWriteRequest = z.infer<typeof HarnessWriteRequestSchema>;

/**
 * How thoroughly the saved content was validated — honesty marker. `full` =
 * parsed by a real parser (json); `lint` = structural line-lint only (toml v1,
 * no TOML dependency); `none` = format has no machine validation (markdown,
 * text).
 */
export const HARNESS_VALIDATIONS = ['full', 'lint', 'none'] as const;
export type HarnessValidationDto = (typeof HARNESS_VALIDATIONS)[number];

/** Successful write response (200). */
export const HarnessWriteResponseSchema = z
  .object({
    written: z.literal(true),
    fileId: z.string().regex(HARNESS_FILE_ID_RE),
    /** sha256 of the bytes now on disk. */
    sha: z.string().regex(SHA256_HEX_RE),
    /** Backup taken of the PREVIOUS content; null when the file was new. */
    backupId: z.string().min(1).nullable(),
    validation: z.enum(HARNESS_VALIDATIONS),
  })
  .strict();
export type HarnessWriteResponse = z.infer<typeof HarnessWriteResponseSchema>;

/** One backup entry (`GET /api/harness/files/:fileId/backups`). */
export const HarnessBackupDtoSchema = z
  .object({
    backupId: z.string().min(1),
    /** Epoch ms the backup was taken. */
    ts: z.number().int().nonnegative(),
    /** sha256 of the backed-up content. */
    sha: z.string().regex(SHA256_HEX_RE),
    bytes: z.number().int().nonnegative(),
  })
  .strict();
export type HarnessBackupDto = z.infer<typeof HarnessBackupDtoSchema>;

/**
 * Restore request (`POST /api/harness/files/:fileId/restore`). A restore runs
 * the FULL write pipeline with the backup's bytes as content (the current
 * content is backed up first), so a restore is itself undoable and the
 * round trip is byte-identical.
 */
export const HarnessRestoreRequestSchema = z
  .object({
    backupId: z.string().min(1),
    /** Optimistic lock on the CURRENT content (null = file absent now). */
    expectedSha: z.string().regex(SHA256_HEX_RE).nullable(),
  })
  .strict();
export type HarnessRestoreRequest = z.infer<typeof HarnessRestoreRequestSchema>;

/**
 * Stable machine error codes the harness routes emit (clients i18n-map them):
 *  - `unknown_file` 404 — fileId not in any adapter catalog;
 *  - `directory_not_editable` 422 — directory-shaped spec;
 *  - `sha_mismatch` 409 — lock lost; body carries `currentSha` (nullable);
 *  - `parse_invalid` 422 — body carries `format`, `detail`, optional `line`;
 *  - `path_jailbreak` 400 — resolved path escaped the allowed roots;
 *  - `file_too_large` 413 — on-disk or submitted content over the cap;
 *  - `backup_not_found` 404 — restore target missing.
 */
export const HARNESS_ERROR_CODES = [
  'unknown_file',
  'directory_not_editable',
  'sha_mismatch',
  'parse_invalid',
  'path_jailbreak',
  'file_too_large',
  'backup_not_found',
] as const;
export type HarnessErrorCode = (typeof HARNESS_ERROR_CODES)[number];

// ---------------------------------------------------------------------------
// "내 커스텀" custom-harness detection — GET /api/harness/custom (READ-ONLY)
// ---------------------------------------------------------------------------

/** What kind of custom harness item was detected. */
export const CUSTOM_HARNESS_KINDS = [
  'hook',
  'statusline',
  'skill',
  'agent',
  'command',
  'mcp',
  'other',
] as const;
export type CustomHarnessKind = (typeof CUSTOM_HARNESS_KINDS)[number];

/**
 * One detected custom item. Detection is READ-ONLY: the scanner opens config
 * files (settings.json, config.toml) and directory listings, never executes
 * anything, never opens credential files, and never modifies mtimes beyond
 * what a read does. `detail` is display-safe (already secret-masked).
 */
export const CustomHarnessItemDtoSchema = z
  .object({
    kind: z.enum(CUSTOM_HARNESS_KINDS),
    toolId: z.string().min(1),
    /** Absolute path of the file/dir the item lives in. */
    path: z.string().min(1),
    /** Short display label, e.g. hook event/matcher or skill name. */
    label: z.string().min(1).optional(),
    /** Display-safe extra (e.g. command basename). Secret-masked. */
    detail: z.string().optional(),
  })
  .strict();
export type CustomHarnessItemDto = z.infer<typeof CustomHarnessItemDtoSchema>;

/** Cap on detected items per scan; overflow sets `truncated` (honest). */
export const CUSTOM_HARNESS_MAX_ITEMS = 500;

/** The "내 커스텀" group (group title itself is client i18n, not wire). */
export const CustomHarnessGroupDtoSchema = z
  .object({
    id: z.literal('custom'),
    /** Epoch ms the scan ran. */
    scannedAt: z.number().int().nonnegative(),
    items: z.array(CustomHarnessItemDtoSchema).max(CUSTOM_HARNESS_MAX_ITEMS),
    truncated: z.boolean(),
  })
  .strict();
export type CustomHarnessGroupDto = z.infer<typeof CustomHarnessGroupDtoSchema>;

// ---------------------------------------------------------------------------
// GUI statusbar — `session.status` postable event + GET /api/sessions/:sid/status
// ---------------------------------------------------------------------------

/**
 * Per-session statusbar snapshot, sourced from the SAME payload the claude
 * statusline stdin receives (adapter-claude `StatusLineInput`; the adapter owns
 * the fold — see `statusLineToSessionStatus`). Keyed by the TOOL-NATIVE session
 * id (same id space as `DiscoveredSession.id` / fleet adapter sessions), not
 * the panel uuid — the shim only knows the tool's own id. Absent source data =
 * honest `null`, never a fabricated zero.
 */
export const SessionStatusDtoSchema = z
  .object({
    toolId: z.string().min(1),
    toolSessionId: z.string().min(1),
    model: z
      .object({ id: z.string().min(1), label: z.string().min(1) })
      .strict()
      .nullable(),
    contextTokens: z
      .object({
        /** Tokens currently occupying the context window. */
        used: z.number().int().nonnegative(),
        /** Context window size. */
        max: z.number().int().positive(),
        /** Source-reported used percentage (not recomputed). */
        usedPercent: z.number().min(0),
      })
      .strict()
      .nullable(),
    costUsd: z.number().nonnegative().nullable(),
    /** Epoch ms of the observation; null when the source gave no clock. */
    asOf: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type SessionStatusDto = z.infer<typeof SessionStatusDtoSchema>;

// ---------------------------------------------------------------------------
// UI keybinding overrides — GET|PUT /api/prefs/keybindings
// ---------------------------------------------------------------------------

/** Action-id rule (web `KEY_ACTIONS` ids: `workspace.nextTab`, `nav.home`…). */
export const KEYBINDING_ACTION_ID_RE = /^[a-z][a-zA-Z0-9.]{0,63}$/;

/** Max override entries accepted in one document. */
export const KEYBINDINGS_MAX_ENTRIES = 200;

/** The keybindings file/DTO name under the server state dir. */
export const KEYBINDINGS_FILE = 'keybindings.json';

/**
 * Server-persisted keybinding overrides (roaming across devices). Combos are
 * OPAQUE to the server (the web keybinding manager owns normalisation and the
 * terminal-scope modifier rule); `null` = explicitly unbound; a missing key =
 * the web default. PUT is full-replace, user-actor only.
 */
export const KeybindingsDtoSchema = z
  .object({
    version: z.literal(1),
    overrides: z.record(
      z.string().regex(KEYBINDING_ACTION_ID_RE),
      z.string().min(1).max(64).nullable(),
    ),
  })
  .strict()
  .refine((v) => Object.keys(v.overrides).length <= KEYBINDINGS_MAX_ENTRIES, {
    message: `overrides must have at most ${KEYBINDINGS_MAX_ENTRIES} entries`,
  });
export type KeybindingsDto = z.infer<typeof KeybindingsDtoSchema>;
