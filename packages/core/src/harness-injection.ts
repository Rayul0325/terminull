/**
 * Harness injection engine (M10) — provenance-ledger-backed, consent-shaped,
 * reversible-by-construction install/eject of Terminull's harness artifacts
 * into tool homes (`~/.claude`, `~/.codex`, …).
 *
 * Division of labour (contract §D2 in .claude/progress/m10-contract.md):
 *  - PRIMITIVES here are REAL and pure: {@link jsonArrayAppendDedup} (parse →
 *    append missing → deterministic 2-space serialize) and the surgical TOML
 *    line patch pair {@link tomlArrayLinePrepend}/{@link tomlArrayLineRemove}
 *    (generalized verbatim from adapter-codex's proven `patchNotify` — NEVER a
 *    TOML reserialization: `[projects.*]` trust tables survive byte-identical).
 *  - The LEDGER SCHEMA is real: `injected.json` records, per tool, exactly
 *    which files were created/patched, the exact inserted bytes, sha
 *    before/after, and the verbatim-backup path — so eject can restore
 *    byte-identical files and DETECT drift (user edits after install).
 *  - {@link InjectionEngine} is REAL: ledger read/write (write-then-rename,
 *    0600) plus a drift-respecting {@link ejectInjectedFile} that restores the
 *    verbatim backup on a clean file, surgically strips our exact fragment when
 *    the file drifted but the fragment survives, and otherwise LEAVES the file.
 *
 * Drift policy (immutable): a file whose current sha != the recorded shaAfter
 * was edited by the user. Eject then attempts SURGICAL removal of exactly the
 * recorded fragment; if the fragment is not present verbatim, the file is
 * LEFT IN PLACE with a warning — user edits are never clobbered.
 *
 * Every test runs against fake homes under
 * `fs.mkdtempSync(path.join(os.tmpdir(), …))` — never the real `~/.claude`,
 * `~/.codex`, `~/.terminull`.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ParseInvalidError, contentSha } from './harness-files.js';

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

/** The JSON anchor path exists but is not an array/object we can append into. */
export class InjectionAnchorError extends Error {
  constructor(readonly keyPath: readonly string[]) {
    super(`injection anchor '${keyPath.join('.')}' exists but is not appendable`);
    this.name = 'InjectionAnchorError';
  }
}

// ---------------------------------------------------------------------------
// JSON primitive — parse → append (dedup) → deterministic serialize
// ---------------------------------------------------------------------------

/** Result of {@link jsonArrayAppendDedup}. */
export interface JsonAppendResult {
  /** New file text (2-space indent + trailing newline). */
  text: string;
  /** Items actually appended (candidates already present are omitted). */
  added: unknown[];
  /** The EXACT serialized fragment(s) recorded in the ledger for eject. */
  addedBytes: string;
}

/**
 * Append `items` into the array at `keyPath` (creating objects/the array along
 * the way), skipping any candidate for which `isSame(existing, candidate)`
 * holds against an existing element. `text === null` means the file does not
 * exist yet (starts from `{}`).
 *
 * HONESTY LIMIT: JSON has no surgical single-line patch — the whole document
 * is reserialized (2-space + trailing newline), so a user's exotic formatting
 * is normalized on INSTALL. Reversibility is still byte-exact because install
 * backs the original up verbatim and the ledger records shaBefore/backupPath;
 * eject restores those bytes, not a re-serialization.
 *
 * @throws ParseInvalidError when `text` is not valid JSON.
 * @throws InjectionAnchorError when the anchor exists but is not appendable.
 */
export function jsonArrayAppendDedup(
  text: string | null,
  keyPath: readonly string[],
  items: readonly unknown[],
  isSame: (existing: unknown, candidate: unknown) => boolean,
): JsonAppendResult {
  let root: unknown;
  try {
    root = text === null ? {} : JSON.parse(text);
  } catch (err) {
    throw new ParseInvalidError('json', (err as Error).message);
  }
  if (root === null || typeof root !== 'object' || Array.isArray(root)) {
    throw new InjectionAnchorError([]);
  }
  let cursor = root as Record<string, unknown>;
  for (const key of keyPath.slice(0, -1)) {
    const next = cursor[key];
    if (next === undefined) {
      const created: Record<string, unknown> = {};
      cursor[key] = created;
      cursor = created;
    } else if (next !== null && typeof next === 'object' && !Array.isArray(next)) {
      cursor = next as Record<string, unknown>;
    } else {
      throw new InjectionAnchorError(keyPath);
    }
  }
  const leafKey = keyPath[keyPath.length - 1];
  if (leafKey === undefined) throw new InjectionAnchorError(keyPath);
  const leaf = cursor[leafKey];
  let arr: unknown[];
  if (leaf === undefined) {
    arr = [];
    cursor[leafKey] = arr;
  } else if (Array.isArray(leaf)) {
    arr = leaf;
  } else {
    throw new InjectionAnchorError(keyPath);
  }

  const added: unknown[] = [];
  for (const candidate of items) {
    if (!arr.some((existing) => isSame(existing, candidate))) {
      arr.push(candidate);
      added.push(candidate);
    }
  }
  return {
    text: JSON.stringify(root, null, 2) + '\n',
    added,
    addedBytes: added.map((a) => JSON.stringify(a, null, 2)).join('\n'),
  };
}

// ---------------------------------------------------------------------------
// TOML primitive — single-line surgical array patch (NO reserialization)
// ---------------------------------------------------------------------------

/** Outcome of {@link tomlArrayLinePrepend}. */
export interface TomlLinePatch {
  text: string;
  /** True when a whole new `key = [element]` line was inserted. */
  addedLine: boolean;
  /** True when `element` was already present (text unchanged). */
  alreadyPresent: boolean;
  /** Set when the file has a multi-line `key = [` array we refuse to touch. */
  unsupported?: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Single-line `key = [ … ]` matcher over the whole file. */
function arrayLineRe(key: string): RegExp {
  const k = escapeRegExp(key);
  return new RegExp(`^([^\\S\\n]*)${k}[^\\S\\n]*=[^\\S\\n]*\\[([^\\]\\n]*)\\]([^\\n]*)$`, 'm');
}

/**
 * Surgically prepend `element` (an exact TOML token, e.g. `"\"/abs/path\""`)
 * to the single-line array `key = […]`, or insert a fresh
 * `key = [element]` line before the first `[table]` header (top-level keys
 * must precede tables; appended at EOF when no header exists). Everything
 * outside that one line is preserved byte-for-byte — this is the load-bearing
 * property that keeps codex `[projects.*]` trust tables byte-identical.
 */
export function tomlArrayLinePrepend(text: string, key: string, element: string): TomlLinePatch {
  const m = arrayLineRe(key).exec(text);
  if (m) {
    const inside = m[2] ?? '';
    if (inside.includes(element)) {
      return { text, addedLine: false, alreadyPresent: true };
    }
    const newInside = inside.trim().length === 0 ? element : `${element}, ${inside}`;
    const line = m[0];
    const replaced = line.replace(`[${inside}]`, `[${newInside}]`);
    return {
      text: text.slice(0, m.index) + replaced + text.slice(m.index + line.length),
      addedLine: false,
      alreadyPresent: false,
    };
  }

  // `key = [` with no closing `]` on the line = multi-line array: refuse.
  const openRe = new RegExp(
    `^[^\\S\\n]*${escapeRegExp(key)}[^\\S\\n]*=[^\\S\\n]*\\[[^\\]\\n]*$`,
    'm',
  );
  if (openRe.test(text)) {
    return {
      text,
      addedLine: false,
      alreadyPresent: false,
      unsupported: `multi-line ${key} array is not surgically patchable`,
    };
  }

  const newLine = `${key} = [${element}]\n`;
  const headerRe = /^[^\S\n]*\[/m;
  const hm = headerRe.exec(text);
  if (hm) {
    return {
      text: text.slice(0, hm.index) + newLine + text.slice(hm.index),
      addedLine: true,
      alreadyPresent: false,
    };
  }
  const sep = text.length === 0 || text.endsWith('\n') ? '' : '\n';
  return { text: text + sep + newLine, addedLine: true, alreadyPresent: false };
}

/**
 * Surgically remove `element` from the single-line array `key = […]`. When
 * `element` is the array's ONLY element the whole line is removed (we added
 * it); otherwise exactly the `element, ` prefix we inserted is stripped,
 * restoring the original array byte-for-byte. Absent element → text returned
 * unchanged (idempotent).
 */
export function tomlArrayLineRemove(text: string, key: string, element: string): string {
  const m = arrayLineRe(key).exec(text);
  if (!m) return text;
  const inside = m[2] ?? '';
  if (!inside.includes(element)) return text;

  if (inside.trim() === element) {
    const line = m[0];
    let end = m.index + line.length;
    if (text[end] === '\n') end += 1;
    return text.slice(0, m.index) + text.slice(end);
  }
  const prefixRe = new RegExp(`${escapeRegExp(element)},[^\\S\\n]*`);
  const line = m[0];
  const restored = line.replace(prefixRe, '');
  return text.slice(0, m.index) + restored + text.slice(m.index + line.length);
}

// ---------------------------------------------------------------------------
// Provenance ledger — `<stateDir>/injected.json`
// ---------------------------------------------------------------------------

/** File name of the provenance ledger inside the Terminull state dir. */
export const INJECTED_LEDGER_FILE = 'injected.json';

/** One file the injector touched: created whole, or surgically patched. */
export const InjectedFileRecordSchema = z
  .object({
    /** Absolute path of the touched file. */
    path: z.string().min(1),
    action: z.enum(['created', 'patched']),
    /** Where inside the file: e.g. 'hooks.SessionStart', 'notify', 'file'. */
    anchor: z.string().min(1),
    /** EXACT bytes our patch inserted (null for whole-file creations). */
    addedBytes: z.string().nullable(),
    /** sha256 hex of the file before our write; null = did not exist. */
    shaBefore: z.string().nullable(),
    /** sha256 hex of the file after our write. */
    shaAfter: z.string(),
    /** Verbatim backup of the original bytes; null when file was created. */
    backupPath: z.string().nullable(),
  })
  .strict();
export type InjectedFileRecord = z.infer<typeof InjectedFileRecordSchema>;

/** Everything one tool's install added, as one atomic provenance unit. */
export const InjectedToolRecordSchema = z
  .object({
    tool: z.string().min(1),
    installedAt: z.number().int().nonnegative(),
    files: z.array(InjectedFileRecordSchema),
  })
  .strict();
export type InjectedToolRecord = z.infer<typeof InjectedToolRecordSchema>;

/** The whole `injected.json`. */
export const InjectedLedgerSchema = z
  .object({
    version: z.literal(1),
    tools: z.array(InjectedToolRecordSchema),
  })
  .strict();
export type InjectedLedger = z.infer<typeof InjectedLedgerSchema>;

/** An empty v1 ledger (absent file semantics). */
export function emptyInjectedLedger(): InjectedLedger {
  return { version: 1, tools: [] };
}

// ---------------------------------------------------------------------------
// Diff + verbatim-backup helpers (used by the CLI to build ledger records)
// ---------------------------------------------------------------------------

/**
 * The single contiguous byte-run that turns `before` into `after`, computed by
 * stripping the common prefix and suffix. For a ONE-PLACE insertion (the codex
 * surgical `notify` line, or any single-line array prepend) this is exactly the
 * bytes inserted, so removing that run verbatim restores `before` — the
 * property {@link ejectInjectedFile} relies on for drift-surgical eject.
 *
 * HONESTY LIMIT: for a MULTI-PLACE change (e.g. re-serialized JSON that gains
 * entries under several keys) the returned run spans intervening bytes and is
 * NOT a clean removal target — the caller records it for provenance only and
 * eject falls back to backup-restore / drift-leave (never a blind strip). The
 * `.json` guard in {@link ejectInjectedFile} additionally refuses any strip
 * that would break JSON parsing.
 */
export function minimalInsertedRun(before: string, after: string): string {
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before[start] === after[start]) start += 1;
  let endB = before.length;
  let endA = after.length;
  while (endB > start && endA > start && before[endB - 1] === after[endA - 1]) {
    endB -= 1;
    endA -= 1;
  }
  return after.slice(start, endA);
}

/** `<stateDir>/backups/injected` — verbatim pre-injection backups live here. */
export function injectedBackupDir(stateDir: string): string {
  return path.join(stateDir, 'backups', 'injected');
}

/**
 * Write a verbatim backup of `bytes` (the exact pre-injection file content) and
 * return its absolute path. Name = `<tool>-<basename>-<sha12>.bak`; mode 0600;
 * lives under {@link injectedBackupDir} (never inside the tool home).
 */
export async function writeVerbatimBackup(
  stateDir: string,
  tool: string,
  filePath: string,
  bytes: string,
): Promise<string> {
  const dir = injectedBackupDir(stateDir);
  await fsp.mkdir(dir, { recursive: true });
  const sha12 = contentSha(bytes).slice(0, 12);
  const dest = path.join(dir, `${tool}-${path.basename(filePath)}-${sha12}.bak`);
  const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, bytes, { mode: 0o600 });
  await fsp.rename(tmp, dest);
  return dest;
}

// ---------------------------------------------------------------------------
// Eject reporting + engine surface
// ---------------------------------------------------------------------------

/** Per-file eject outcome (honest, machine-readable). */
export type EjectFileOutcome =
  /** Current sha matched shaAfter → original bytes restored verbatim. */
  | 'restored'
  /** We created the file and it is unmodified → unlinked. */
  | 'removed'
  /** File drifted but our exact fragment was found → surgically stripped. */
  | 'surgical'
  /** File drifted AND our fragment is gone/altered → LEFT with a warning. */
  | 'drift_left'
  /** File no longer exists → nothing to do. */
  | 'missing';

/** Result of ejecting one tool. */
export interface EjectReport {
  tool: string;
  files: { path: string; outcome: EjectFileOutcome; warning?: string }[];
  /** True when every record ended in restored/removed/surgical/missing. */
  clean: boolean;
}

/** Options for {@link InjectionEngine}. */
export interface InjectionEngineOptions {
  /** Absolute path of `injected.json` (usually `<stateDir>/injected.json`). */
  ledgerPath: string;
}

async function readMaybe(file: string): Promise<string | null> {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function atomicWrite(file: string, bytes: string, mode = 0o600): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, bytes, { mode });
  await fsp.rename(tmp, file);
}

/**
 * Eject ONE recorded file per the immutable drift policy (D2):
 *   1. current sha == shaAfter → restore backup verbatim (`restored`) or unlink
 *      a file we created (`removed`).
 *   2. drifted, our exact `addedBytes` fragment still present verbatim → strip
 *      exactly that run (`surgical`); a `.json` target additionally must still
 *      parse after the strip, else we treat it as drift.
 *   3. drifted and the fragment is gone/altered → LEAVE the file (`drift_left`).
 *   4. file missing → `missing`.
 * Never clobbers user edits: every write path is byte-exact or refused.
 */
export async function ejectInjectedFile(
  record: InjectedFileRecord,
): Promise<{ outcome: EjectFileOutcome; warning?: string }> {
  const current = await readMaybe(record.path);
  if (current === null) return { outcome: 'missing' };

  if (contentSha(current) === record.shaAfter) {
    if (record.action === 'created') {
      await fsp.unlink(record.path).catch(() => {});
      return { outcome: 'removed' };
    }
    if (record.backupPath !== null) {
      const backup = await readMaybe(record.backupPath);
      if (backup !== null) {
        await atomicWrite(record.path, backup);
        return { outcome: 'restored' };
      }
    }
    // Patched but the backup vanished — fall through to a surgical attempt.
  }

  // Drifted (or backup lost): try an exact-fragment surgical strip.
  if (record.addedBytes !== null && record.addedBytes.length > 0) {
    const idx = current.indexOf(record.addedBytes);
    if (idx !== -1) {
      const stripped = current.slice(0, idx) + current.slice(idx + record.addedBytes.length);
      if (record.path.endsWith('.json')) {
        try {
          JSON.parse(stripped);
        } catch {
          return {
            outcome: 'drift_left',
            warning: `${record.path} was edited; removing our entry would break its JSON — left untouched`,
          };
        }
      }
      await atomicWrite(record.path, stripped);
      return { outcome: 'surgical' };
    }
  }

  return {
    outcome: 'drift_left',
    warning: `${record.path} was edited after install; our fragment is gone — left untouched`,
  };
}

/**
 * Ledger-backed injection engine (provenance record/eject/drift accounting).
 * Composition: the CLI runs the per-tool adapter injectors for file mechanics
 * and this engine for the `injected.json` ledger + drift-respecting eject. The
 * ledger is written write-then-rename at mode 0600 (store.ts discipline).
 */
export class InjectionEngine {
  constructor(private readonly opts: InjectionEngineOptions) {}

  /** Read + schema-validate the ledger; absent file → empty ledger. */
  async load(): Promise<InjectedLedger> {
    const raw = await readMaybe(this.opts.ledgerPath);
    if (raw === null) return emptyInjectedLedger();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new ParseInvalidError('json', (err as Error).message);
    }
    return InjectedLedgerSchema.parse(parsed);
  }

  private async save(ledger: InjectedLedger): Promise<void> {
    await atomicWrite(this.opts.ledgerPath, JSON.stringify(ledger, null, 2) + '\n');
  }

  /** Upsert one tool's install record (replaces any prior entry for the tool). */
  async record(record: InjectedToolRecord): Promise<void> {
    const ledger = await this.load();
    const tools = ledger.tools.filter((t) => t.tool !== record.tool);
    tools.push(record);
    await this.save({ version: 1, tools });
  }

  /**
   * Eject one tool per the drift policy, remove its ledger entry ONLY when the
   * eject was clean (every file restored/removed/surgical/missing), and report
   * per-file outcomes. A `drift_left` keeps the entry so the user can retry.
   */
  async eject(tool: string): Promise<EjectReport> {
    const ledger = await this.load();
    const entry = ledger.tools.find((t) => t.tool === tool);
    if (!entry) return { tool, files: [], clean: true };

    const files: EjectReport['files'] = [];
    let clean = true;
    for (const rec of entry.files) {
      const { outcome, warning } = await ejectInjectedFile(rec);
      if (outcome === 'drift_left') clean = false;
      files.push({ path: rec.path, outcome, ...(warning ? { warning } : {}) });
    }

    if (clean) {
      await this.save({ version: 1, tools: ledger.tools.filter((t) => t.tool !== tool) });
    }
    return { tool, files, clean };
  }

  /** Ledger entry for a tool, or null. */
  async status(tool: string): Promise<InjectedToolRecord | null> {
    const ledger = await this.load();
    return ledger.tools.find((t) => t.tool === tool) ?? null;
  }
}
