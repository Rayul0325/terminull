/**
 * Claude Code transcript parser — ports control-tower's `server/transcript.js`
 * into the SDK {@link TranscriptParser} contract.
 *
 * A session transcript is a `.jsonl` file that can exceed 60 MB, so it is read
 * as a WINDOW, never whole: the first read tails the file; follow-up reads
 * resume from a byte cursor. All offset arithmetic is in Buffer space so a
 * multibyte UTF-8 char is never split at a window edge.
 *
 * Records are normalised to SDK {@link ChatItem}s. The transcript's own
 * semantic kind is mapped onto the SDK's `(role, kind)` pair and preserved
 * verbatim under `raw.semantic` so a renderer keeps the tool payload. The
 * mapping (2026-07-06 parity extension) covers the observed record kinds:
 *  - user text / slash-command chip → `user` / `command`;
 *  - assistant text / `tool_use` (with its pairing `id`) → `assistant` /
 *    `tool_use`;
 *  - assistant `thinking` blocks → `reasoning` (text preserved, GUI collapses);
 *  - user-carried `tool_result` blocks → `tool_result`, carrying
 *    `{toolUseId, isError, payload}` so M6 can PAIR them with their `tool_use`;
 *  - sidechain (subagent) records → a single bounded `sidechain` MARKER per
 *    record (identity only, no recursive expansion) so M6 can group threads;
 *  - `system` / `summary` / `compaction` / `progress` records → `system` with a
 *    `subtype`;
 *  - `isMeta` records and the P1-deferred session-meta stream (mode /
 *    permission-mode / ai-title / …) are still dropped (folded into session
 *    state later, not chat items);
 *  - anything else (a torn line, or a novel record type) → the honest
 *    `unparsed` fallback item, never a silent drop.
 */
import fsp from 'node:fs/promises';
import type {
  ChatItem,
  TranscriptCursor,
  TranscriptParser,
  TranscriptRef,
  TranscriptWindow,
} from '@terminull/adapter-sdk';

const DEFAULT_INITIAL_WINDOW = 512 * 1024; // tail bytes on first load
const DEFAULT_FOLLOW_CAP = 2 * 1024 * 1024; // max bytes per incremental read
const DEFAULT_MAX_ITEMS = 400; // hard cap per response
const TEXT_CAP = 8000; // per-bubble text cap (UI renders, not archives)

/** Tunable window sizes (defaults match production; tests shrink them). */
export interface ClaudeParserOptions {
  initialWindow?: number;
  followCap?: number;
  maxItems?: number;
}

/** A byte-offset cursor into a transcript. Extends the SDK cursor honestly. */
export interface ByteCursor extends TranscriptCursor {
  readonly kind: 'byte';
  readonly offset: number;
}

/** A transcript window carrying Claude's honesty flags atop the SDK window. */
export interface ClaudeTranscriptWindow extends TranscriptWindow {
  cursor: ByteCursor;
  /** The visible head of the conversation was omitted (initial tail / cap). */
  truncatedHead: boolean;
  /** More items parsed than returned — the cursor jumped past a mid-stream gap. */
  droppedOlder: boolean;
  /** The file shrank/rotated under a stale cursor; the client should resync. */
  reset: boolean;
}

/** The semantic kind carried in `ChatItem.raw` for renderers that want detail. */
export type ClaudeItemSemantic =
  | 'user'
  | 'assistant'
  | 'command'
  | 'tool_use'
  | 'reasoning'
  | 'tool_result'
  | 'sidechain'
  | 'system'
  | 'unparsed';

interface ToolUseBlock {
  type: 'tool_use';
  /** The `toolu_*` id a later `tool_result` references (pairing key). */
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}
interface TextBlock {
  type: 'text';
  text?: string;
}
interface ThinkingBlock {
  type: 'thinking';
  /** Extended-thinking blocks carry the text under `thinking`; some under `text`. */
  thinking?: string;
  text?: string;
}
interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id?: string;
  is_error?: boolean;
  /** Result payload: a plain string or an array of content blocks. */
  content?: unknown;
}
type ContentBlock = ToolUseBlock | TextBlock | ThinkingBlock | ToolResultBlock | { type: string };

interface ClaudeRecord {
  type?: string;
  /** `system` record discriminator (e.g. `compact_boundary`, `api_error`). */
  subtype?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  timestamp?: string;
  /** Subagent identity fields that may ride on a sidechain record. */
  slug?: string;
  agentId?: string;
  agentType?: string;
  /** Structured tool-result envelope that accompanies a `tool_result` block. */
  toolUseResult?: unknown;
  message?: { content?: string | ContentBlock[] };
}

/**
 * Record types folded into session state later (gap-matrix P1) — dropped today,
 * exactly as before this extension, so the window is not flooded by the
 * high-volume session-meta stream. Distinct from `isMeta` (injected context).
 */
const DEFERRED_TYPES: ReadonlySet<string> = new Set([
  'mode',
  'permission-mode',
  'ai-title',
  'custom-title',
  'agent-name',
  'last-prompt',
  'attachment',
  'queue-operation',
  'file-history-snapshot',
  'bridge-session',
]);

/** Record types normalised to a single `system` item carrying a `subtype`. */
const SYSTEM_TYPES: ReadonlySet<string> = new Set(['system', 'summary', 'compaction', 'progress']);

/** Flatten a tool_result `content` (string | block array) to a text preview. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        c && typeof c === 'object' && (c as { type?: string }).type === 'text'
          ? String((c as { text?: unknown }).text ?? '')
          : '',
      )
      .join('')
      .trim();
  }
  return '';
}

/** Compact, human-readable summary of a tool call's input (ported). */
function toolDetail(name: string, input: Record<string, unknown> = {}): string {
  const s = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
  switch (name) {
    case 'Bash':
      return s(input['description']) || s(input['command']).slice(0, 100);
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return s(input['file_path']).split('/').slice(-2).join('/');
    case 'Grep':
    case 'Glob':
      return s(input['pattern']);
    case 'Task':
    case 'Agent':
      return s(input['description']) || s(input['prompt']).slice(0, 80);
    case 'WebFetch':
      return s(input['url']);
    case 'WebSearch':
      return s(input['query']);
    case 'TodoWrite':
      return 'todo list updated';
    case 'AskUserQuestion': {
      const qs = input['questions'];
      const first = Array.isArray(qs) ? qs[0] : undefined;
      const q =
        first && typeof first === 'object' ? (first as Record<string, unknown>)['question'] : '';
      return s(q).slice(0, 100);
    }
    case 'ExitPlanMode':
      return 'plan approval requested';
    default: {
      const j = JSON.stringify(input ?? {});
      return j.length > 100 ? j.slice(0, 100) + '…' : j;
    }
  }
}

/** Strip harness-injected tag blocks a human never typed (ported + broadened). */
function cleanUserText(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '')
    .replace(/<local-command-stderr>[\s\S]*?<\/local-command-stderr>/g, '')
    .trim();
}

function tsOf(rec: ClaudeRecord): number | undefined {
  if (!rec.timestamp) return undefined;
  const n = Date.parse(rec.timestamp);
  return Number.isNaN(n) ? undefined : n;
}

/**
 * One transcript JSONL record → 0..n normalised {@link ChatItem}s. `lineNo` and
 * the per-record block index make a deterministic, stable id.
 */
function recordToItems(rec: ClaudeRecord, lineNo: number): ChatItem[] {
  if (!rec) return [];
  const ts = tsOf(rec);
  const withTs = ts !== undefined ? { ts } : {};
  const id = (block: number): string => `c${lineNo}.${block}`;

  // Injected context (isMeta) stays dropped. A sidechain (subagent) record
  // becomes ONE bounded marker carrying identity only — never its content —
  // so M6 can group subagent threads without expanding them into the window.
  if (rec.isMeta) return [];
  if (rec.isSidechain) {
    const identity: Record<string, unknown> = { recordType: rec.type ?? 'unknown' };
    if (rec.slug) identity['slug'] = rec.slug;
    if (rec.agentId) identity['agentId'] = rec.agentId;
    if (rec.agentType) identity['agentType'] = rec.agentType;
    const label = rec.agentType || rec.slug || rec.agentId;
    return [
      {
        id: id(0),
        role: 'system',
        kind: 'sidechain',
        text: label ? `subagent: ${label}` : 'subagent thread',
        ...withTs,
        raw: { semantic: 'sidechain' as ClaudeItemSemantic, ...identity },
      },
    ];
  }

  if (rec.type === 'user') {
    const c = rec.message?.content;
    const blocks: ContentBlock[] =
      typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : [];
    const out: ChatItem[] = [];
    let block = 0;
    for (const b of blocks) {
      // A tool_result rides on a user record; keep it paired to its tool_use.
      if (b?.type === 'tool_result') {
        const tr = b as ToolResultBlock;
        out.push({
          id: id(block++),
          role: 'tool',
          kind: 'tool_result',
          text: toolResultText(tr.content).slice(0, TEXT_CAP),
          ...withTs,
          raw: {
            semantic: 'tool_result' as ClaudeItemSemantic,
            ...(tr.tool_use_id ? { toolUseId: tr.tool_use_id } : {}),
            isError: tr.is_error === true,
            payload: tr.content,
            ...(rec.toolUseResult !== undefined ? { toolUseResult: rec.toolUseResult } : {}),
          },
        });
        continue;
      }
      if (b?.type !== 'text') continue;
      const raw = (b as TextBlock).text;
      if (typeof raw !== 'string') continue;
      // Slash-command invocations render as a compact chip, not a wall of XML.
      const cmd = /<command-name>([^<]+)<\/command-name>/.exec(raw);
      if (cmd) {
        const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(raw);
        const name = (cmd[1] ?? '').trim();
        const argText = (args?.[1] ?? '').trim().slice(0, 200);
        out.push({
          id: id(block++),
          role: 'user',
          kind: 'event',
          text: argText ? `${name} ${argText}` : name,
          ...withTs,
          raw: { semantic: 'command' as ClaudeItemSemantic, command: name, args: argText },
        });
        continue;
      }
      const text = cleanUserText(raw);
      if (text) {
        out.push({
          id: id(block++),
          role: 'user',
          kind: 'message',
          text: text.slice(0, TEXT_CAP),
          ...withTs,
        });
      }
    }
    return out;
  }

  if (rec.type === 'assistant') {
    const c = rec.message?.content;
    if (!Array.isArray(c)) return [];
    const out: ChatItem[] = [];
    let block = 0;
    for (const x of c) {
      if (x?.type === 'text') {
        const t = (x as TextBlock).text;
        if (typeof t === 'string' && t.trim()) {
          out.push({
            id: id(block++),
            role: 'agent',
            kind: 'message',
            text: t.slice(0, TEXT_CAP),
            ...withTs,
          });
        }
      } else if (x?.type === 'thinking') {
        // Reasoning is preserved (M6 collapses it by default), no longer dropped.
        const th = x as ThinkingBlock;
        const t = th.thinking ?? th.text;
        if (typeof t === 'string' && t.trim()) {
          out.push({
            id: id(block++),
            role: 'agent',
            kind: 'reasoning',
            text: t.slice(0, TEXT_CAP),
            ...withTs,
            raw: { semantic: 'reasoning' as ClaudeItemSemantic },
          });
        }
      } else if (x?.type === 'tool_use') {
        const tu = x as ToolUseBlock;
        const name = tu.name ?? '?';
        const input = tu.input ?? {};
        out.push({
          id: id(block++),
          role: 'agent',
          kind: 'tool_call',
          text: toolDetail(name, input),
          ...withTs,
          raw: {
            semantic: 'tool_use' as ClaudeItemSemantic,
            name,
            input,
            // The pairing key a later tool_result references, when present.
            ...(tu.id ? { toolUseId: tu.id } : {}),
          },
        });
      }
      // image / document blocks: P1 — not surfaced yet.
    }
    return out;
  }

  // system / summary / compaction / progress → one honest system item + subtype.
  if (rec.type && SYSTEM_TYPES.has(rec.type)) {
    const subtype = rec.subtype ?? rec.type;
    return [
      {
        id: id(0),
        role: 'system',
        kind: 'system',
        text: `system: ${subtype}`,
        ...withTs,
        raw: { semantic: 'system' as ClaudeItemSemantic, subtype, recordType: rec.type },
      },
    ];
  }

  // P1-deferred session-meta stream: folded into session state later, dropped now.
  if (rec.type && DEFERRED_TYPES.has(rec.type)) return [];

  // A novel/unexpected record type → honest fallback, never a silent drop.
  return [
    {
      id: id(0),
      role: 'system',
      kind: 'event',
      text: `‹${rec.type ?? 'unknown record'}›`,
      ...withTs,
      raw: { semantic: 'unparsed' as ClaudeItemSemantic, recordType: rec.type ?? null },
    },
  ];
}

/**
 * Reads Claude Code transcripts in monotonic byte windows. Stateless: the byte
 * cursor is the entire resumption state, so one instance serves every session.
 */
export class ClaudeTranscriptParser implements TranscriptParser {
  private readonly initialWindow: number;
  private readonly followCap: number;
  private readonly maxItems: number;

  constructor(opts: ClaudeParserOptions = {}) {
    this.initialWindow = opts.initialWindow ?? DEFAULT_INITIAL_WINDOW;
    this.followCap = opts.followCap ?? DEFAULT_FOLLOW_CAP;
    this.maxItems = opts.maxItems ?? DEFAULT_MAX_ITEMS;
  }

  /** SDK contract entry point (returns the base window view). */
  async readWindow(ref: TranscriptRef, cursor?: TranscriptCursor): Promise<TranscriptWindow> {
    return this.readWindowDetailed(ref, cursor);
  }

  /** Full window with Claude's honesty flags (used by the GUI + tests). */
  async readWindowDetailed(
    ref: TranscriptRef,
    cursor?: TranscriptCursor,
  ): Promise<ClaudeTranscriptWindow> {
    if (ref.kind !== 'file') {
      throw new Error(`ClaudeTranscriptParser only reads 'file' refs, got '${ref.kind}'`);
    }
    const from = cursor?.offset;
    const fh = await fsp.open(ref.path, 'r');
    try {
      const { size } = await fh.stat();
      const initial = from == null || from > size; // shrunk/rotated → resync
      const reset = from != null && from > size;
      const start = initial ? Math.max(0, size - this.initialWindow) : from;
      const len = Math.min(size - start, initial ? this.initialWindow : this.followCap);
      const buf = Buffer.alloc(Math.max(0, len));
      if (len > 0) await fh.read(buf, 0, len, start);

      // Buffer-space alignment: drop the torn head (initial tail only) and the
      // torn last line (file mid-write); the cursor stops at the last COMPLETE
      // line so the next poll re-reads nothing and misses nothing.
      let bufStart = 0;
      if (initial && start > 0) {
        const nl = buf.indexOf(0x0a);
        bufStart = nl >= 0 ? nl + 1 : len;
      }
      const lastNl = buf.lastIndexOf(0x0a);
      const bufEnd = lastNl >= bufStart ? lastNl + 1 : bufStart;
      const offset = start + bufEnd;

      const items: ChatItem[] = [];
      if (bufEnd > bufStart) {
        let lineNo = 0;
        for (const line of buf.toString('utf8', bufStart, bufEnd).split('\n')) {
          if (!line) continue;
          const n = lineNo++;
          try {
            items.push(...recordToItems(JSON.parse(line) as ClaudeRecord, n));
          } catch {
            // Torn/corrupt line → honest 'unparsed' item, never a silent drop.
            items.push({
              id: `c${n}.0`,
              role: 'system',
              kind: 'event',
              text: line.length > 200 ? line.slice(0, 200) + '…' : line,
              raw: { semantic: 'unparsed' as ClaudeItemSemantic, line },
            });
          }
        }
      }

      const droppedOlder = items.length > this.maxItems;
      const byteCursor: ByteCursor = { kind: 'byte', offset };
      return {
        items: items.slice(-this.maxItems),
        cursor: byteCursor,
        done: offset >= size,
        reset,
        droppedOlder,
        truncatedHead: (initial && start > 0) || (initial && droppedOlder),
      };
    } finally {
      await fh.close();
    }
  }
}
