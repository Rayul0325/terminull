/**
 * Harness-file write pipeline (M9) — the CORE-owned engine behind
 * `PUT /api/harness/files/:fileId` and `/restore`.
 *
 * Pipeline order is a CONTRACT (each stage fails typed, later stages never run):
 *   1. jail        — the resolved path must sit inside an allowed root
 *                    ({@link assertInsideRoots}); symlinked targets are refused;
 *   2. validation  — format-parse the candidate content
 *                    ({@link validatorForFormat}: json = full parse, toml =
 *                    structural lint, markdown/text = none — the honesty level
 *                    is reported back, never inflated);
 *   3. sha lock    — optimistic concurrency on the CURRENT content's sha256
 *                    ({@link ShaMismatchError} → HTTP 409);
 *   4. backup      — previous content saved under
 *                    `<backupsDir>/<fileId>/<ts>-<sha12>.bak`, rotation keeps
 *                    the newest {@link HARNESS_BACKUP_ROTATION};
 *   5. atomic write— temp file + rename, preserving an existing file's mode
 *                    (new files 0600);
 *   6. audit facts — the RESULT carries sha/backupId/bytes for the caller's
 *                    `harness.file_written` event. Content and diffs are NEVER
 *                    part of the result's audit surface.
 *
 * Like {@link PermissionSettings}, this module is deliberately decoupled from
 * the event store: it returns audit-ready facts, the server appends events.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HARNESS_BACKUP_ROTATION, HARNESS_MAX_CONTENT_BYTES } from '@terminull/shared';

// ---------------------------------------------------------------------------
// Typed pipeline errors (server maps them onto the wire codes)
// ---------------------------------------------------------------------------

/** Stage 3 failure: the caller's `expectedSha` no longer matches disk. → 409 */
export class ShaMismatchError extends Error {
  readonly code = 'sha_mismatch';
  constructor(
    /** sha256 of the content currently on disk; null when the file is absent. */
    readonly currentSha: string | null,
  ) {
    super('expectedSha does not match the current content');
    this.name = 'ShaMismatchError';
  }
}

/** Stage 2 failure: the candidate content does not parse/lint. → 422 */
export class ParseInvalidError extends Error {
  readonly code = 'parse_invalid';
  constructor(
    /** Format that failed ('json' | 'toml' | …). */
    readonly format: string,
    /** Parser/linter message — surfaced verbatim to the client. */
    readonly detail: string,
    /** 1-based line, when the parser could locate the problem. */
    readonly line?: number,
  ) {
    super(`invalid ${format}: ${detail}`);
    this.name = 'ParseInvalidError';
  }
}

/** Stage 1 failure: the path escapes every allowed root. → 400 */
export class PathJailError extends Error {
  readonly code = 'path_jailbreak';
  constructor(readonly attempted: string) {
    super(`path escapes the allowed roots: ${attempted}`);
    this.name = 'PathJailError';
  }
}

/** Restore target does not exist. → 404 */
export class BackupNotFoundError extends Error {
  readonly code = 'backup_not_found';
  constructor(readonly backupId: string) {
    super(`backup not found: ${backupId}`);
    this.name = 'BackupNotFoundError';
  }
}

/** Content (submitted or on disk) exceeds the editable cap. → 413 */
export class FileTooLargeError extends Error {
  readonly code = 'file_too_large';
  constructor(readonly bytes: number) {
    super(`content is ${bytes} bytes; the editable cap is ${HARNESS_MAX_CONTENT_BYTES}`);
    this.name = 'FileTooLargeError';
  }
}

/** Scaffold-only: a pipeline body the M9 server track has not implemented yet. */
export class HarnessNotImplementedError extends Error {
  readonly code = 'not_implemented';
  constructor(what: string) {
    super(`${what} is not implemented yet (M9 server track)`);
    this.name = 'HarnessNotImplementedError';
  }
}

/** fileId shape doubling as the backup-dir jail (no `/`, no `..`, no drive). */
const FILE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Backup file-name shape: `<epoch-ms>-<sha-first-12>.bak`. */
const BACKUP_NAME_RE = /^(\d{1,15})-([0-9a-f]{12})\.bak$/;

// ---------------------------------------------------------------------------
// Pure helpers (REAL)
// ---------------------------------------------------------------------------

/** sha256 hex of the exact content bytes (utf8 for strings). */
export function contentSha(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Stage-1 jail: `abs` must resolve INSIDE one of `roots`. Pure path math —
 * callers must additionally refuse symlinked targets via lstat before writing
 * (filesystem half lives in the engine, tested with fake homes).
 */
export function assertInsideRoots(abs: string, roots: readonly string[]): void {
  const resolved = path.resolve(abs);
  for (const root of roots) {
    const rel = path.relative(path.resolve(root), resolved);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return;
  }
  throw new PathJailError(resolved);
}

/** One validation problem; `null` from a validator means "content is fine". */
export interface ParseIssue {
  detail: string;
  line?: number;
}

/** Validates candidate content for one format. */
export type FormatValidator = (content: string) => ParseIssue | null;

/** Honesty level of a format's validation (mirrors the wire enum). */
export type HarnessValidationLevel = 'full' | 'lint' | 'none';

/** Full JSON parse — the `settings.json` corruption gate. */
export const jsonValidator: FormatValidator = (content) => {
  try {
    JSON.parse(content);
    return null;
  } catch (e) {
    return { detail: e instanceof Error ? e.message : String(e) };
  }
};

/**
 * Minimal structural TOML lint (NO toml dependency — honest `lint` level, not
 * `full`): per line, tolerate blanks/comments, require `[table]` headers to
 * close their brackets, require key/value lines to carry `=`, and catch
 * unterminated basic strings. Multi-line strings (`"""`/`'''`) are passed
 * through unchecked (documented limit).
 */
export const tomlLintValidator: FormatValidator = (content) => {
  const lines = content.split('\n');
  let inMultiline = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (inMultiline) {
      if (line.includes('"""') || line.includes("'''")) inMultiline = false;
      continue;
    }
    const startsMulti =
      (line.split('"""').length - 1) % 2 === 1 || (line.split("'''").length - 1) % 2 === 1;
    if (startsMulti) {
      inMultiline = true;
      continue;
    }
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('[')) {
      if (!trimmed.replace(/#.*$/, '').trim().endsWith(']')) {
        return { detail: 'unterminated table header', line: i + 1 };
      }
      continue;
    }
    if (!trimmed.includes('=')) {
      return { detail: 'expected `key = value` or `[table]`', line: i + 1 };
    }
    // Odd count of unescaped double quotes = an unterminated basic string.
    const unescaped = trimmed.replace(/\\"/g, '');
    if ((unescaped.split('"').length - 1) % 2 === 1) {
      return { detail: 'unterminated string', line: i + 1 };
    }
  }
  if (inMultiline) return { detail: 'unterminated multi-line string' };
  return null;
};

/**
 * The validator + honesty level for a wire format. Unknown/prose formats get
 * `none` with an always-pass validator — the response says so, never claiming
 * a parse that did not happen.
 */
export function validatorForFormat(format: string): {
  validator: FormatValidator;
  level: HarnessValidationLevel;
} {
  switch (format) {
    case 'json':
      return { validator: jsonValidator, level: 'full' };
    case 'toml':
      return { validator: tomlLintValidator, level: 'lint' };
    default:
      return { validator: () => null, level: 'none' };
  }
}

// ---------------------------------------------------------------------------
// Engine surface
// ---------------------------------------------------------------------------

/** What {@link HarnessFileEngine.read} reports about a file. */
export interface HarnessFileState {
  exists: boolean;
  content: string | null;
  sha: string | null;
  size: number | null;
  mtime: number | null;
}

/** Audit-ready facts of a completed write (NO content, NO diff). */
export interface HarnessWriteFacts {
  sha: string;
  backupId: string | null;
  validation: HarnessValidationLevel;
  bytes: number;
}

/** One backup entry as listed from disk. */
export interface HarnessBackupEntry {
  backupId: string;
  ts: number;
  sha: string;
  bytes: number;
}

/** Options for {@link HarnessFileEngine}. */
export interface HarnessFileEngineOptions {
  /** Backup storage root, e.g. `<stateDir>/harness-backups`. */
  backupsDir: string;
  /** Jail roots writes must stay inside (harness home and/or project cwd). */
  jailRoots: readonly string[];
  /** Backups kept per file (default {@link HARNESS_BACKUP_ROTATION}). */
  rotation?: number;
  /** Editable size cap in bytes (default {@link HARNESS_MAX_CONTENT_BYTES}). */
  maxBytes?: number;
}

/**
 * The core write pipeline. See the module doc for the stage contract; every
 * method takes the CATALOG-validated fileId (used only to key backups) and the
 * resolved absolute path (jailed here again — defence in depth).
 */
export class HarnessFileEngine {
  /** Backups kept per file (resolved from opts). */
  readonly rotation: number;
  /** Editable size cap in bytes (resolved from opts). */
  readonly maxBytes: number;

  constructor(readonly opts: HarnessFileEngineOptions) {
    this.rotation = opts.rotation ?? HARNESS_BACKUP_ROTATION;
    this.maxBytes = opts.maxBytes ?? HARNESS_MAX_CONTENT_BYTES;
  }

  /** fileId is regex-jailed BEFORE any fs use (it names the backup dir). */
  private assertFileId(fileId: string): void {
    if (!FILE_ID_RE.test(fileId)) throw new PathJailError(fileId);
  }

  /** Current on-disk bytes, or null when absent. Over-cap reads → 413. */
  private readBytes(absPath: string): Buffer | null {
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(absPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
    if (bytes.length > this.maxBytes) throw new FileTooLargeError(bytes.length);
    return bytes;
  }

  /** Stage-1 filesystem half: a symlinked final path is a jail escape. */
  private refuseSymlink(absPath: string): void {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(absPath);
    } catch {
      return; // absent = nothing to escape through
    }
    if (st.isSymbolicLink()) throw new PathJailError(absPath);
  }

  /** Read current state (absent file = honest nulls; typed errors reject). */
  async read(fileId: string, absPath: string): Promise<HarnessFileState> {
    this.assertFileId(fileId);
    assertInsideRoots(absPath, this.opts.jailRoots);
    const bytes = this.readBytes(absPath);
    if (bytes === null) {
      return { exists: false, content: null, sha: null, size: null, mtime: null };
    }
    const st = fs.statSync(absPath);
    return {
      exists: true,
      content: bytes.toString('utf8'),
      sha: contentSha(bytes),
      size: bytes.length,
      mtime: Math.round(st.mtimeMs),
    };
  }

  /** Run the full pipeline (stages 1–5) and return audit facts (stage 6). */
  async write(
    fileId: string,
    absPath: string,
    input: { expectedSha: string | null; content: string; format: string },
  ): Promise<HarnessWriteFacts> {
    // Stage 1 — jail: path math + symlink refusal on the final path AND parent.
    this.assertFileId(fileId);
    const resolved = path.resolve(absPath);
    assertInsideRoots(resolved, this.opts.jailRoots);
    this.refuseSymlink(resolved);
    const candidate = Buffer.from(input.content, 'utf8');
    if (candidate.length > this.maxBytes) throw new FileTooLargeError(candidate.length);

    // Stage 2 — format validation (the honesty level travels to the caller).
    const { validator, level } = validatorForFormat(input.format);
    const issue = validator(input.content);
    if (issue) throw new ParseInvalidError(input.format, issue.detail, issue.line);

    // Stage 3 — sha optimistic lock against the bytes ON DISK, re-read here
    // (TOCTOU honesty: never trust a cached read across await points).
    const current = this.readBytes(resolved);
    const currentSha = current === null ? null : contentSha(current);
    if (input.expectedSha !== currentSha) throw new ShaMismatchError(currentSha);

    // Stage 4 — backup the previous content, then rotate. A backup failure
    // ABORTS the write (throws): an unrecoverable settings.json overwrite is
    // the exact disaster this pipeline exists to prevent.
    let backupId: string | null = null;
    if (current !== null) backupId = this.takeBackup(fileId, current);

    // Stage 5 — atomic write: temp file in the SAME dir + rename. Preserve an
    // existing file's mode; new files are 0600; parents mkdir'd only in-jail.
    const dir = path.dirname(resolved);
    assertInsideRoots(dir, this.opts.jailRoots);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const mode = current !== null ? fs.statSync(resolved).mode & 0o777 : 0o600;
    const tmp = path.join(dir, `.${path.basename(resolved)}.tmp-${process.pid}-${Date.now()}`);
    fs.writeFileSync(tmp, candidate, { mode });
    fs.renameSync(tmp, resolved);

    // Stage 6 — audit facts only (NO content, NO diff).
    return { sha: contentSha(candidate), backupId, validation: level, bytes: candidate.length };
  }

  /** The (regex-jailed) backup dir for one fileId. */
  private backupDir(fileId: string): string {
    this.assertFileId(fileId);
    return path.join(this.opts.backupsDir, fileId);
  }

  /** Write one backup (0600) and rotate the dir down to `rotation` entries. */
  private takeBackup(fileId: string, previous: Buffer): string {
    const dir = this.backupDir(fileId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const sha = contentSha(previous);
    const backupId = `${Date.now()}-${sha.slice(0, 12)}.bak`;
    fs.writeFileSync(path.join(dir, backupId), previous, { mode: 0o600 });
    // Rotation: keep the newest N by timestamp (name-encoded), unlink the rest.
    const entries = fs
      .readdirSync(dir)
      .filter((name) => BACKUP_NAME_RE.test(name))
      .sort((a, b) => this.tsOf(b) - this.tsOf(a) || b.localeCompare(a));
    for (const name of entries.slice(this.rotation)) {
      fs.unlinkSync(path.join(dir, name));
    }
    return backupId;
  }

  private tsOf(name: string): number {
    const m = BACKUP_NAME_RE.exec(name);
    return m ? Number(m[1]) : 0;
  }

  /**
   * Newest-first backups for a file. The full sha is recomputed from each
   * backup's bytes; an entry whose bytes no longer match its name prefix is a
   * tampered backup and is omitted (it would also refuse to restore).
   */
  async listBackups(fileId: string): Promise<HarnessBackupEntry[]> {
    const dir = this.backupDir(fileId);
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return []; // no backups yet — an honest empty list
    }
    const entries: HarnessBackupEntry[] = [];
    for (const name of names) {
      const m = BACKUP_NAME_RE.exec(name);
      if (!m) continue;
      let bytes: Buffer;
      try {
        bytes = fs.readFileSync(path.join(dir, name));
      } catch {
        continue;
      }
      const sha = contentSha(bytes);
      if (!sha.startsWith(m[2]!)) continue; // tampered — never listed as valid
      entries.push({ backupId: name, ts: Number(m[1]), sha, bytes: bytes.length });
    }
    entries.sort((a, b) => b.ts - a.ts || b.backupId.localeCompare(a.backupId));
    return entries;
  }

  /**
   * Restore = read the backup's bytes, then run {@link write} with them (the
   * current content is backed up first) — byte-identical, itself undoable.
   */
  async restore(
    fileId: string,
    absPath: string,
    input: { backupId: string; expectedSha: string | null; format: string },
  ): Promise<HarnessWriteFacts> {
    const dir = this.backupDir(fileId);
    const m = BACKUP_NAME_RE.exec(input.backupId);
    if (!m) throw new BackupNotFoundError(input.backupId); // shape IS the jail
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(path.join(dir, input.backupId));
    } catch {
      throw new BackupNotFoundError(input.backupId);
    }
    // Full-sha verification against the name prefix: a tampered backup is
    // backup_not_found, never silently restored.
    if (!contentSha(bytes).startsWith(m[2]!)) throw new BackupNotFoundError(input.backupId);
    return this.write(fileId, absPath, {
      expectedSha: input.expectedSha,
      content: bytes.toString('utf8'),
      format: input.format,
    });
  }
}
