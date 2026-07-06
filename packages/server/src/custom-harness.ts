/**
 * '내 커스텀' custom-harness detection (M9 §6) — a READ-ONLY scan of the
 * configured home for hooks, statusline, skills/agents/commands and MCP
 * servers the user wired up themselves.
 *
 * Hard rules (violations are security bugs, not preferences):
 *  - READ-ONLY: config files and directory listings only; nothing is written,
 *    executed, or created — a scan leaves every mtime and the file tree
 *    byte-identical.
 *  - Credential files are NEVER opened: `auth.json`, `.credentials.json`, and
 *    any name matching /token|credential|secret/i are skipped WITHOUT reading.
 *  - Per-source degradation: a broken settings.json yields zero items from
 *    that source, never a 500 for the whole group.
 *  - `detail` strings are display-safe (secret-masked basenames).
 */
import fs from 'node:fs';
import path from 'node:path';
import { maskSecrets } from '@terminull/core';
import {
  CUSTOM_HARNESS_MAX_ITEMS,
  type CustomHarnessGroupDto,
  type CustomHarnessItemDto,
} from '@terminull/shared';

/** Names that must never be opened OR listed as items (credential stores). */
const CREDENTIAL_NAME_RE = /token|credential|secret|auth\.json$/i;

/** True when a file/dir name looks credential-bearing — skip without reading. */
export function isCredentialLike(name: string): boolean {
  return CREDENTIAL_NAME_RE.test(name);
}

/** What the scanner needs to know about the world (fixture-able in tests). */
export interface CustomScanContext {
  /** The harness home (prod: real home; tests: a fake mkdtemp home). */
  home: string;
  /** Project root for cwd-scoped configs (.claude/settings.local.json, .mcp.json). */
  cwd: string;
  /** Epoch ms treated as "now" (injected for deterministic tests). */
  now?: number;
}

interface Sink {
  items: CustomHarnessItemDto[];
  truncated: boolean;
}

function push(sink: Sink, item: CustomHarnessItemDto): void {
  if (sink.items.length >= CUSTOM_HARNESS_MAX_ITEMS) {
    sink.truncated = true; // honest cap, never a silent drop
    return;
  }
  sink.items.push(item);
}

/** Read a small text file, refusing credential-like names. Null on any miss. */
function readTextGuarded(file: string): string | null {
  if (isCredentialLike(path.basename(file))) return null;
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Claude settings.json / settings.local.json → hook + statusline items. */
function scanClaudeSettings(sink: Sink, file: string): void {
  const raw = readTextGuarded(file);
  if (raw === null) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return; // broken settings degrade to zero items from this source
  }
  if (parsed === null || typeof parsed !== 'object') return;
  const settings = parsed as Record<string, unknown>;

  const hooks = settings['hooks'];
  if (hooks !== null && typeof hooks === 'object') {
    for (const [event, matchers] of Object.entries(hooks as Record<string, unknown>)) {
      if (!Array.isArray(matchers)) continue;
      for (const entry of matchers) {
        if (entry === null || typeof entry !== 'object') continue;
        const m = entry as Record<string, unknown>;
        const matcher =
          typeof m['matcher'] === 'string' && m['matcher'].length > 0 ? m['matcher'] : null;
        const inner = Array.isArray(m['hooks']) ? m['hooks'] : [];
        for (const hook of inner) {
          if (hook === null || typeof hook !== 'object') continue;
          const command = (hook as Record<string, unknown>)['command'];
          if (typeof command !== 'string' || command.length === 0) continue;
          push(sink, {
            kind: 'hook',
            toolId: 'claude',
            path: file,
            label: matcher !== null ? `${event} ${matcher}` : event,
            detail: maskSecrets(path.basename(command)),
          });
        }
      }
    }
  }

  const statusLine = settings['statusLine'];
  if (statusLine !== null && typeof statusLine === 'object') {
    const command = (statusLine as Record<string, unknown>)['command'];
    if (typeof command === 'string' && command.length > 0) {
      push(sink, {
        kind: 'statusline',
        toolId: 'claude',
        path: file,
        label: 'statusLine',
        detail: maskSecrets(path.basename(command)),
      });
    }
  }
}

/** One item per entry of a skills/agents/commands directory listing. */
function scanEntryDir(
  sink: Sink,
  dir: string,
  kind: 'skill' | 'agent' | 'command',
  toolId: string,
): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return; // absent dir = zero items (a normal state)
  }
  for (const name of names.sort()) {
    if (name.startsWith('.')) continue;
    if (isCredentialLike(name)) continue; // never even named in the group
    push(sink, { kind, toolId, path: path.join(dir, name), label: name });
  }
}

/** Codex config.toml line scan: `notify` hook + `[mcp_servers.*]` tables. */
function scanCodexConfig(sink: Sink, file: string): void {
  const raw = readTextGuarded(file);
  if (raw === null) return;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (/^notify\s*=/.test(trimmed)) {
      push(sink, { kind: 'hook', toolId: 'codex', path: file, label: 'notify' });
      continue;
    }
    const table = /^\[mcp_servers\.(.+?)\]/.exec(trimmed);
    if (table) {
      push(sink, {
        kind: 'mcp',
        toolId: 'codex',
        path: file,
        label: maskSecrets(table[1]!.replace(/^"|"$/g, '')),
      });
    }
  }
}

/** Project `.mcp.json`: one item per configured server. */
function scanMcpJson(sink: Sink, file: string): void {
  const raw = readTextGuarded(file);
  if (raw === null) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (parsed === null || typeof parsed !== 'object') return;
  const servers = (parsed as Record<string, unknown>)['mcpServers'];
  if (servers === null || typeof servers !== 'object') return;
  for (const [name, cfg] of Object.entries(servers as Record<string, unknown>).sort()) {
    const command =
      cfg !== null && typeof cfg === 'object'
        ? (cfg as Record<string, unknown>)['command']
        : undefined;
    push(sink, {
      kind: 'mcp',
      toolId: 'claude',
      path: file,
      label: maskSecrets(name),
      ...(typeof command === 'string' && command.length > 0
        ? { detail: maskSecrets(path.basename(command)) }
        : {}),
    });
  }
}

/** Run the full read-only scan and return the '내 커스텀' group DTO. */
export function scanCustomHarness(ctx: CustomScanContext): CustomHarnessGroupDto {
  const sink: Sink = { items: [], truncated: false };
  const claudeHome = path.join(ctx.home, '.claude');

  scanClaudeSettings(sink, path.join(claudeHome, 'settings.json'));
  scanClaudeSettings(sink, path.join(ctx.cwd, '.claude', 'settings.local.json'));
  scanEntryDir(sink, path.join(claudeHome, 'skills'), 'skill', 'claude');
  scanEntryDir(sink, path.join(claudeHome, 'agents'), 'agent', 'claude');
  scanEntryDir(sink, path.join(claudeHome, 'commands'), 'command', 'claude');
  scanCodexConfig(sink, path.join(ctx.home, '.codex', 'config.toml'));
  scanMcpJson(sink, path.join(ctx.cwd, '.mcp.json'));

  return {
    id: 'custom',
    scannedAt: ctx.now ?? Date.now(),
    items: sink.items,
    truncated: sink.truncated,
  };
}
