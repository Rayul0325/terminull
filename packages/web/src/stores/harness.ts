/**
 * Harness-editor store (M9 W2). Wraps the contract routes:
 * `GET /api/harness/files` (manifest groups), `GET /api/harness/custom`
 * (read-only '내 커스텀' detection), per-file read → edit → save with the
 * `expectedSha` optimistic lock, backups list + restore.
 *
 * Honesty rules the UI relies on:
 *  - a 409 save is a CONFLICT state carrying the server's `currentSha` — the
 *    draft is kept, nothing is retried silently;
 *  - a 422 save is the parser's own message, surfaced VERBATIM (detail+line),
 *    and the file on disk is unchanged;
 *  - a successful save reports its real validation depth (full/lint/none) —
 *    the UI must not dress a toml lint up as a full parse.
 */
import { create } from 'zustand';
import type {
  CustomHarnessGroupDto,
  HarnessBackupDto,
  HarnessGroupDto,
  HarnessReadDto,
  HarnessValidationDto,
} from '@terminull/shared';
import { ApiHttpError, api } from '../api/client';

/** Terminal state of the last save/restore attempt on a file. */
export type SaveOutcome =
  | { kind: 'saved'; validation: HarnessValidationDto; sha: string }
  | { kind: 'conflict'; currentSha: string | null }
  | { kind: 'parse_invalid'; format: string; detail: string; line?: number }
  | { kind: 'error'; code: string };

export interface HarnessFileEditState {
  fileId: string;
  read: HarnessReadDto | null;
  /** Editor buffer (seeded from read.content; '' for absent files). */
  draft: string;
  loading: boolean;
  readErrorCode: string | null;
  saving: boolean;
  outcome: SaveOutcome | null;
  backups: HarnessBackupDto[] | null;
  backupsErrorCode: string | null;
}

interface HarnessState {
  groups: HarnessGroupDto[];
  loaded: boolean;
  errorCode: string | null;
  custom: CustomHarnessGroupDto | null;
  customErrorCode: string | null;
  files: Record<string, HarnessFileEditState>;
  loadManifest(): Promise<void>;
  loadCustom(): Promise<void>;
  /** Read a file into an edit buffer (fresh read every open). */
  open(fileId: string): Promise<void>;
  setDraft(fileId: string, draft: string): void;
  /** PUT with the last-read sha as the optimistic lock. */
  save(fileId: string): Promise<void>;
  loadBackups(fileId: string): Promise<void>;
  /** Restore a backup through the full pipeline (locked on the current sha). */
  restore(fileId: string, backupId: string): Promise<void>;
}

function blankFile(fileId: string): HarnessFileEditState {
  return {
    fileId,
    read: null,
    draft: '',
    loading: false,
    readErrorCode: null,
    saving: false,
    outcome: null,
    backups: null,
    backupsErrorCode: null,
  };
}

function outcomeOfError(e: unknown): SaveOutcome {
  if (e instanceof ApiHttpError) {
    if (e.status === 409 && e.code === 'sha_mismatch') {
      const currentSha = e.body['currentSha'];
      return { kind: 'conflict', currentSha: typeof currentSha === 'string' ? currentSha : null };
    }
    if (e.status === 422 && e.code === 'parse_invalid') {
      // Surfaced VERBATIM — the server relays the parser's own message.
      const detail = e.body['detail'];
      const format = e.body['format'];
      const line = e.body['line'];
      return {
        kind: 'parse_invalid',
        format: typeof format === 'string' ? format : '',
        detail: typeof detail === 'string' ? detail : '',
        ...(typeof line === 'number' ? { line } : {}),
      };
    }
    return { kind: 'error', code: e.code };
  }
  return { kind: 'error', code: 'network' };
}

export const useHarnessStore = create<HarnessState>((set, get) => {
  const patchFile = (fileId: string, p: Partial<HarnessFileEditState>): void => {
    const prev = get().files[fileId] ?? blankFile(fileId);
    set({ files: { ...get().files, [fileId]: { ...prev, ...p } } });
  };

  return {
    groups: [],
    loaded: false,
    errorCode: null,
    custom: null,
    customErrorCode: null,
    files: {},

    loadManifest: async () => {
      try {
        const res = await api.harnessFiles();
        set({ groups: res.groups, loaded: true, errorCode: null });
      } catch (e) {
        const code = e instanceof ApiHttpError ? e.code : 'network';
        set({ errorCode: code });
      }
    },

    loadCustom: async () => {
      try {
        const custom = await api.harnessCustom();
        set({ custom, customErrorCode: null });
      } catch (e) {
        const code = e instanceof ApiHttpError ? e.code : 'network';
        set({ customErrorCode: code });
      }
    },

    open: async (fileId) => {
      patchFile(fileId, { loading: true, readErrorCode: null, outcome: null });
      try {
        const read = await api.harnessRead(fileId);
        patchFile(fileId, { read, draft: read.content ?? '', loading: false });
      } catch (e) {
        const code = e instanceof ApiHttpError ? e.code : 'network';
        patchFile(fileId, { loading: false, readErrorCode: code });
      }
    },

    setDraft: (fileId, draft) => patchFile(fileId, { draft }),

    save: async (fileId) => {
      const entry = get().files[fileId];
      if (!entry || entry.read === null || entry.saving) return;
      patchFile(fileId, { saving: true, outcome: null });
      try {
        const res = await api.harnessWrite(fileId, {
          // Lock on the sha of the content we READ (null = "must not exist").
          expectedSha: entry.read.sha,
          content: entry.draft,
        });
        patchFile(fileId, {
          saving: false,
          outcome: { kind: 'saved', validation: res.validation, sha: res.sha },
          // The read state now reflects what is on disk.
          read: {
            ...entry.read,
            exists: true,
            content: entry.draft,
            sha: res.sha,
          },
        });
      } catch (e) {
        // 409/422 keep the DRAFT untouched — the user's edit is never lost.
        patchFile(fileId, { saving: false, outcome: outcomeOfError(e) });
      }
    },

    loadBackups: async (fileId) => {
      try {
        const res = await api.harnessBackups(fileId);
        patchFile(fileId, { backups: res.backups, backupsErrorCode: null });
      } catch (e) {
        const code = e instanceof ApiHttpError ? e.code : 'network';
        patchFile(fileId, { backupsErrorCode: code });
      }
    },

    restore: async (fileId, backupId) => {
      const entry = get().files[fileId];
      if (!entry || entry.read === null || entry.saving) return;
      patchFile(fileId, { saving: true, outcome: null });
      try {
        const res = await api.harnessRestore(fileId, {
          backupId,
          expectedSha: entry.read.sha,
        });
        // Restore rewrote the file — re-read for the true bytes + fresh lock,
        // and refresh the rotation-affected backups list, THEN report success
        // (open() clears `outcome` while it runs).
        await get().open(fileId);
        await get().loadBackups(fileId);
        patchFile(fileId, {
          saving: false,
          outcome: { kind: 'saved', validation: res.validation, sha: res.sha },
        });
      } catch (e) {
        patchFile(fileId, { saving: false, outcome: outcomeOfError(e) });
      }
    },
  };
});
