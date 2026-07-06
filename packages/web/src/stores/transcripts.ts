/**
 * Windowed transcript store — one bounded window per session, LRU-capped.
 *
 * Each entry mirrors the adapter parser's honest window semantics: a byte
 * cursor that only moves forward, `truncatedHead` when older history was not
 * loaded, and an explicit `supported:false` state for sessions without a
 * transcript (never an empty-but-green list). The client additionally caps
 * items per session (window) and total sessions (LRU) so a long-running panel
 * cannot grow without bound.
 */
import { create } from 'zustand';
import { api } from '../api/client';
import type { ChatItem } from '../api/types';

export const MAX_SESSIONS = 8;
export const MAX_ITEMS_PER_SESSION = 500;

export interface TranscriptEntry {
  sessionId: string;
  supported: boolean | null; // null = not fetched yet
  reasonCode?: string;
  items: ChatItem[];
  cursor?: number;
  done: boolean;
  /** True when items were dropped client-side or server-side at the head. */
  truncatedHead: boolean;
  loading: boolean;
  errorCode: string | null;
  lastUsedAt: number;
}

interface TranscriptsState {
  entries: Record<string, TranscriptEntry>;
  /** Fetch the next window for a session (initial or cursor continuation). */
  fetchMore(sessionId: string): Promise<void>;
  /** Mark a session as visible (LRU touch) creating its entry if needed. */
  touch(sessionId: string): void;
  evictIfNeeded(): void;
}

function blank(sessionId: string): TranscriptEntry {
  return {
    sessionId,
    supported: null,
    items: [],
    done: false,
    truncatedHead: false,
    loading: false,
    errorCode: null,
    lastUsedAt: Date.now(),
  };
}

export const useTranscriptsStore = create<TranscriptsState>((set, get) => ({
  entries: {},

  touch: (sessionId) => {
    const entries = { ...get().entries };
    entries[sessionId] = { ...(entries[sessionId] ?? blank(sessionId)), lastUsedAt: Date.now() };
    set({ entries });
    get().evictIfNeeded();
  },

  evictIfNeeded: () => {
    const entries = get().entries;
    const ids = Object.keys(entries);
    if (ids.length <= MAX_SESSIONS) return;
    const sorted = ids.sort((a, b) => entries[a]!.lastUsedAt - entries[b]!.lastUsedAt);
    const evict = sorted.slice(0, ids.length - MAX_SESSIONS);
    const next = { ...entries };
    for (const id of evict) delete next[id];
    set({ entries: next });
  },

  fetchMore: async (sessionId) => {
    const current = get().entries[sessionId] ?? blank(sessionId);
    if (current.loading) return;
    set({
      entries: {
        ...get().entries,
        [sessionId]: { ...current, loading: true, lastUsedAt: Date.now() },
      },
    });
    try {
      const res = await api.transcript(sessionId, current.cursor);
      const prev = get().entries[sessionId] ?? current;
      if (!res.supported) {
        set({
          entries: {
            ...get().entries,
            [sessionId]: {
              ...prev,
              supported: false,
              reasonCode: res.reason,
              loading: false,
              errorCode: null,
            },
          },
        });
        return;
      }
      // The parser resets its window when the file rotated under the cursor —
      // mirror that by dropping our accumulated items instead of mixing runs.
      const base = res.reset ? [] : prev.items;
      let items = res.items.length > 0 ? [...base, ...res.items] : base;
      let clientTruncated = false;
      if (items.length > MAX_ITEMS_PER_SESSION) {
        items = items.slice(items.length - MAX_ITEMS_PER_SESSION);
        clientTruncated = true;
      }
      set({
        entries: {
          ...get().entries,
          [sessionId]: {
            ...prev,
            supported: true,
            items,
            cursor: res.cursor.offset,
            done: res.done,
            truncatedHead:
              prev.truncatedHead ||
              clientTruncated ||
              res.truncatedHead === true ||
              res.reset === true,
            loading: false,
            errorCode: null,
          },
        },
      });
    } catch (e) {
      const prev = get().entries[sessionId] ?? current;
      const code =
        e instanceof Error && 'code' in e ? String((e as { code: unknown }).code) : 'network';
      set({
        entries: { ...get().entries, [sessionId]: { ...prev, loading: false, errorCode: code } },
      });
    }
    get().evictIfNeeded();
  },
}));
