/**
 * Codex CLI model registry.
 *
 * Three sources, each honest about provenance:
 *  1. `'configured'` — `model = "…"` values parsed out of `config.toml` (the
 *     root entry and any `[profiles.*]` / `[projects.*]` overrides). This matches
 *     the declared `modelDiscovery: 'configured'` capability.
 *  2. `'discovered'` — model ids actually seen in recent rollouts (the
 *     `turn_context` `"model"` field), so the list reflects real usage.
 *  3. `'fallback'` — a single honest placeholder used ONLY when neither source
 *     yields anything, so the panel always has at least one entry to show.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { HarnessContext, ModelInfo, ModelRegistry } from '@terminull/adapter-sdk';
import { listRollouts } from './collector.js';

const DEFAULT_MAX_SCAN = 12;
const TAIL_BYTES = 64 * 1024;

/** Options for {@link createCodexModelRegistry}. */
export interface CodexModelRegistryOptions {
  /** Override the `.codex` home (defaults to `<ctx.home ?? homedir>/.codex`). */
  codexHome?: string;
  /** Override the `config.toml` path (defaults to `<codexHome>/config.toml`). */
  configPath?: string;
  /** How many recent rollouts to scan for model ids. Default 12. */
  maxScan?: number;
}

/** Parse `model = "…"` entries out of raw TOML (no full parser needed). */
export function parseConfiguredModels(toml: string | null | undefined): string[] {
  if (typeof toml !== 'string') return [];
  const out: string[] = [];
  for (const rawLine of toml.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('#')) continue;
    const m = /^model\s*=\s*(.+?)\s*(#.*)?$/.exec(line);
    if (!m || !m[1]) continue;
    const val = m[1].replace(/^["']|["']$/g, '').trim();
    if (val.length > 0 && !out.includes(val)) out.push(val);
  }
  return out;
}

async function readTail(file: string, bytes = TAIL_BYTES): Promise<string> {
  const fh = await fsp.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    if (len > 0) await fh.read(buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally {
    await fh.close();
  }
}

/** Scan the most recently modified rollouts for distinct model ids. */
async function discoverModelIds(codexHome: string, maxScan: number): Promise<string[]> {
  const rollouts = await listRollouts(path.join(codexHome, 'sessions'));
  rollouts.sort((a, b) => b.mtime - a.mtime);
  const seen = new Set<string>();
  for (const r of rollouts.slice(0, maxScan)) {
    try {
      const tail = await readTail(r.file);
      for (const m of tail.matchAll(/"model"\s*:\s*"([A-Za-z0-9._-]+)"/g)) {
        const id = m[1];
        if (id) seen.add(id);
      }
    } catch {
      /* unreadable rollout — skip */
    }
  }
  return [...seen];
}

/**
 * Create a Codex CLI model registry. `list` returns configured ids first, then
 * discovered ids not already configured, then a single fallback when neither
 * source is available.
 */
export function createCodexModelRegistry(opts: CodexModelRegistryOptions = {}): ModelRegistry {
  const maxScan = opts.maxScan ?? DEFAULT_MAX_SCAN;
  return {
    async list(ctx?: HarnessContext): Promise<ModelInfo[]> {
      const codexHome = opts.codexHome ?? path.join(ctx?.home ?? os.homedir(), '.codex');
      const configPath = opts.configPath ?? path.join(codexHome, 'config.toml');

      let toml: string | null = null;
      try {
        toml = await fsp.readFile(configPath, 'utf8');
      } catch {
        /* no config.toml */
      }
      const configured = parseConfiguredModels(toml);
      const discovered = await discoverModelIds(codexHome, maxScan);

      const out: ModelInfo[] = [];
      const have = new Set<string>();
      for (const id of configured) {
        out.push({ id, label: id, source: 'configured' });
        have.add(id);
      }
      for (const id of discovered) {
        if (have.has(id)) continue;
        out.push({ id, label: id, source: 'discovered' });
        have.add(id);
      }
      if (out.length === 0) {
        out.push({ id: 'default', label: 'CLI default (unspecified)', source: 'fallback' });
      }
      return out;
    },
  };
}
