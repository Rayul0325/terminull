/**
 * Claude Code model registry.
 *
 * Two sources, both honest about provenance:
 *  1. `'discovered'` — model ids actually seen in recent transcripts
 *     (`"model":"…"` fields), so the list reflects what this install has used.
 *  2. `'fallback'` — the generic tier aliases `opus` / `sonnet` / `haiku`, which
 *     `--model` always accepts. Deliberately NOT pinned to a dated model id: the
 *     `'fallback'` tag is the ONLY assumption made about "what's current".
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { HarnessContext, ModelInfo, ModelRegistry } from '@terminull/adapter-sdk';

/** Generic tier aliases `--model` accepts; no dated-model assumption. */
const FALLBACK_ALIASES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
];

/** Options for {@link createClaudeModelRegistry}. */
export interface ClaudeModelRegistryOptions {
  /** Override the `.claude` home (defaults to `<ctx.home ?? homedir>/.claude`). */
  claudeHome?: string;
  /** How many recent transcripts to scan for model ids. Default 12. */
  maxScan?: number;
}

async function readTail(file: string, bytes = 64 * 1024): Promise<string> {
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

/** Scan the most recently modified transcripts for distinct model ids. */
async function discoverModelIds(projectsDir: string, maxScan: number): Promise<string[]> {
  let dirs: string[] = [];
  try {
    dirs = await fsp.readdir(projectsDir);
  } catch {
    return [];
  }
  const files: { file: string; mtime: number }[] = [];
  await Promise.all(
    dirs.map(async (d) => {
      const dp = path.join(projectsDir, d);
      let entries: string[];
      try {
        entries = await fsp.readdir(dp);
      } catch {
        return;
      }
      await Promise.all(
        entries.map(async (e) => {
          if (!e.endsWith('.jsonl')) return;
          try {
            const st = await fsp.stat(path.join(dp, e));
            files.push({ file: path.join(dp, e), mtime: st.mtimeMs });
          } catch {
            /* raced deletion */
          }
        }),
      );
    }),
  );
  files.sort((a, b) => b.mtime - a.mtime);
  const seen = new Set<string>();
  for (const { file } of files.slice(0, maxScan)) {
    try {
      const tail = await readTail(file);
      for (const m of tail.matchAll(/"model"\s*:\s*"([A-Za-z0-9._-]+)"/g)) {
        const id = m[1];
        if (id && id !== '<synthetic>') seen.add(id);
      }
    } catch {
      /* unreadable transcript — skip */
    }
  }
  return [...seen];
}

/**
 * Create a Claude Code model registry. `list` returns discovered ids first
 * (source `'discovered'`), then any fallback alias not already discovered
 * (source `'fallback'`).
 */
export function createClaudeModelRegistry(opts: ClaudeModelRegistryOptions = {}): ModelRegistry {
  const maxScan = opts.maxScan ?? 12;
  return {
    async list(ctx?: HarnessContext): Promise<ModelInfo[]> {
      const claudeHome = opts.claudeHome ?? path.join(ctx?.home ?? os.homedir(), '.claude');
      const projectsDir = path.join(claudeHome, 'projects');
      const discovered = await discoverModelIds(projectsDir, maxScan);
      const out: ModelInfo[] = discovered.map((id) => ({ id, label: id, source: 'discovered' }));
      const have = new Set(discovered);
      for (const alias of FALLBACK_ALIASES) {
        if (!have.has(alias.id)) out.push({ id: alias.id, label: alias.label, source: 'fallback' });
      }
      return out;
    },
  };
}
