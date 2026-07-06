/**
 * ChatItem renderer registry — THE CONTRACT parallel renderer packets build
 * against. Read RENDERERS.md (same directory) for the work-packet list.
 *
 * ## Model
 *
 * Every transcript entry is an adapter-normalized `ChatItem`
 * (`@terminull/adapter-sdk`). A renderer registers a {@link RendererSpec}
 * whose `match` narrows on up to three axes:
 *
 *   - `adapterId` — the owning tool ('claude', 'codex', 'generic-pty', …)
 *   - `kind`      — ChatItem.kind. The union is ADDITIVE across releases
 *                   ('message' | 'tool_call' | 'tool_result' | 'event' |
 *                   'reasoning' | 'sidechain' | 'system' today); treat any
 *                   unknown kind as renderable only by the generic fallback.
 *   - `toolName`  — for kind 'tool_call'/'tool_result': the tool's name,
 *                   extracted via {@link toolNameOf}. The reserved value
 *                   `'mcp__*'` matches ANY name starting with `mcp__` after
 *                   exact-name lookup misses.
 *
 * ## Resolution (deterministic)
 *
 * specificity = (toolName? 4:0) + (kind? 2:0) + (adapterId? 1:0).
 * Highest specificity wins; ties break by REGISTRATION ORDER (earlier wins).
 * `resolve()` never returns null — the generic fallback is registered by this
 * module itself and matches everything. A renderer that throws is caught by
 * RendererHost's per-item ErrorBoundary and replaced by an honest error chip
 * plus the generic fallback (a broken plugin renderer can never blank a
 * transcript).
 *
 * ## Claude raw shapes (parser contract, packages/adapters/claude/src/parser.ts)
 *
 *   tool_call   → raw: { semantic:'tool_use', name, input, id? }
 *   tool_result → raw: { semantic:'tool_result', toolUseId, isError?, payload? }
 *   command     → raw: { semantic:'command', command, args }
 *   unparsed    → raw: { semantic:'unparsed', line }
 *
 * (`id` on tool_call and the whole tool_result emission are the in-flight
 * parser parity extension; pairing code must treat both as OPTIONAL and show
 * the honest "결과 미수신" state when absent.)
 *
 * ## Pairing (gap-matrix P0 #1)
 *
 * `pairToolResults()` walks a window once and returns tool_result items keyed
 * by their target tool_call item id. SessionPanel feeds each tool_call its
 * paired result via `ctx.pairedResult` and HIDES the paired tool_result item
 * from the flat list (the card owns rendering it). Unpaired results still
 * render standalone (never silently dropped).
 *
 * ## Rules for renderer packets
 *
 *   1. One packet = one renderer = one file under src/renderers/tools/ (or
 *      kinds/), default-exporting nothing — call {@link registerRenderer} at
 *      module scope and add the import to src/renderers/index.ts.
 *   2. No cross-packet imports. Shared UI = the primitives in
 *      src/renderers/parts/ only.
 *   3. Every user-facing string via `ctx.t` (i18n keys, ko+en).
 *   4. Honesty: unknown/missing fields render as explicit "확인 중"/absent
 *      states — never invented values, never green-by-default.
 *   5. Each packet ships a vitest colocated file asserting resolve() picks it
 *      for its fixture item and that it renders without the paired result.
 */
import type { ComponentType } from 'react';
import type { TFunction } from 'i18next';
import type { ChatItem } from '../api/types';

// ---------------------------------------------------------------------------
// Context handed to every renderer
// ---------------------------------------------------------------------------

/** A detail view opened in the session side panel (상세보기 계약). */
export interface DetailView {
  /** Stable id so re-opening the same detail replaces, not stacks. */
  id: string;
  /** Title: prefer `titleKey` (i18n); `title` is for literal values (paths). */
  titleKey?: string;
  title?: string;
  content:
    | { kind: 'text'; value: string; language?: string }
    | { kind: 'markdown'; value: string }
    | { kind: 'diff'; before: string; after: string; path?: string }
    | { kind: 'html'; value: string };
}

export interface RendererContext {
  adapterId: string;
  sessionId: string;
  t: TFunction;
  /** Paired tool_result for a tool_call item, when the parser emitted one. */
  pairedResult?: ChatItem;
  /** Open the 상세보기 side panel (SessionPanel owns the surface). */
  openDetail(view: DetailView): void;
  /** Jump to this session's terminal panel (workspace-only affordance). */
  jumpToTerminal?: (sessionId: string) => void;
}

export interface RendererProps {
  item: ChatItem;
  ctx: RendererContext;
}

// ---------------------------------------------------------------------------
// Registration + resolution
// ---------------------------------------------------------------------------

export interface RendererMatch {
  adapterId?: string;
  kind?: string;
  /** Exact tool name, or the reserved wildcard 'mcp__*'. */
  toolName?: string;
}

export interface RendererSpec {
  /** Unique renderer id ('tool.bash', 'kind.reasoning', …). */
  id: string;
  match: RendererMatch;
  Component: ComponentType<RendererProps>;
}

const specs: RendererSpec[] = [];

/** Register a renderer (module-scope call). Duplicate ids are rejected. */
export function registerRenderer(spec: RendererSpec): void {
  if (specs.some((s) => s.id === spec.id)) {
    throw new Error(`renderer id already registered: ${spec.id}`);
  }
  specs.push(spec);
}

/** Test-only: reset the registry (never call from app code). */
export function resetRegistryForTest(): void {
  specs.length = 0;
}

/** Extract a tool name from an item's raw payload (claude shape documented above). */
export function toolNameOf(item: ChatItem): string | undefined {
  const raw = item.raw;
  if (raw && typeof raw === 'object') {
    const name = (raw as Record<string, unknown>)['name'];
    if (typeof name === 'string' && name.length > 0) return name;
  }
  return undefined;
}

function specificity(match: RendererMatch): number {
  return (
    (match.toolName !== undefined ? 4 : 0) +
    (match.kind !== undefined ? 2 : 0) +
    (match.adapterId !== undefined ? 1 : 0)
  );
}

function matches(
  match: RendererMatch,
  item: ChatItem,
  adapterId: string,
  name: string | undefined,
): boolean {
  if (match.adapterId !== undefined && match.adapterId !== adapterId) return false;
  if (match.kind !== undefined && match.kind !== item.kind) return false;
  if (match.toolName !== undefined) {
    if (name === undefined) return false;
    if (match.toolName === 'mcp__*') {
      if (!name.startsWith('mcp__')) return false;
    } else if (match.toolName !== name) return false;
  }
  return true;
}

/**
 * Resolve the renderer for an item. Never null: the generic fallback (see
 * GenericItem.tsx, registered via index.ts) matches everything. Exact
 * toolName candidates beat the 'mcp__*' wildcard at equal specificity because
 * wildcard entries only match after an exact-name miss.
 */
export function resolveRenderer(item: ChatItem, adapterId: string): RendererSpec {
  const name = toolNameOf(item);
  let best: RendererSpec | null = null;
  let bestScore = -1;
  let bestWildcard = true;
  for (const spec of specs) {
    if (!matches(spec.match, item, adapterId, name)) continue;
    const score = specificity(spec.match);
    const wildcard = spec.match.toolName === 'mcp__*';
    // exact-over-wildcard at equal score; otherwise higher score wins;
    // ties keep the EARLIER registration.
    if (score > bestScore || (score === bestScore && bestWildcard && !wildcard)) {
      best = spec;
      bestScore = score;
      bestWildcard = wildcard;
    }
  }
  if (!best) {
    throw new Error(
      'renderer registry has no fallback — import src/renderers/index.ts before resolving',
    );
  }
  return best;
}

/** All registered specs (settings/debug surfaces). */
export function listRenderers(): readonly RendererSpec[] {
  return specs;
}

// ---------------------------------------------------------------------------
// tool_use ↔ tool_result pairing
// ---------------------------------------------------------------------------

function rawField(item: ChatItem, key: string): unknown {
  const raw = item.raw;
  if (raw && typeof raw === 'object') return (raw as Record<string, unknown>)[key];
  return undefined;
}

export interface PairedWindow {
  /** tool_call item.id → its tool_result item. */
  resultByCallId: Map<string, ChatItem>;
  /** item.ids of tool_result items consumed by pairing (hide from flat list). */
  pairedResultIds: Set<string>;
}

/**
 * Pair tool_result items to their tool_call within one window. Contract:
 * tool_call carries raw.id (the tool_use block id), tool_result carries
 * raw.toolUseId (defensive fallback: raw.tool_use_id). Missing ids simply
 * produce no pair — the honest unpaired states render on both sides.
 */
export function pairToolResults(items: readonly ChatItem[]): PairedWindow {
  const callByToolUseId = new Map<string, ChatItem>();
  for (const item of items) {
    if (item.kind !== 'tool_call') continue;
    const id = rawField(item, 'id');
    if (typeof id === 'string' && id.length > 0) callByToolUseId.set(id, item);
  }
  const resultByCallId = new Map<string, ChatItem>();
  const pairedResultIds = new Set<string>();
  for (const item of items) {
    if (item.kind !== 'tool_result') continue;
    const target = rawField(item, 'toolUseId') ?? rawField(item, 'tool_use_id');
    if (typeof target !== 'string') continue;
    const call = callByToolUseId.get(target);
    if (!call || resultByCallId.has(call.id)) continue;
    resultByCallId.set(call.id, item);
    pairedResultIds.add(item.id);
  }
  return { resultByCallId, pairedResultIds };
}
