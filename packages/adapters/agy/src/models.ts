/**
 * Antigravity (`agy`) model registry.
 *
 * HONESTY / SAFETY: agy ships an `agy models` subcommand, but listing models may
 * make a NETWORK call, so this registry NEVER invokes it. Instead it reads the
 * locally-configured model out of `<geminiHome>/settings.json` (`.model`) and
 * reports it with provenance `'configured'`. When no model is configured it
 * returns `[]` rather than fabricating a model id — the capability
 * `modelDiscovery: 'configured'` describes the mechanism (config-derived, not a
 * live dynamic query), and an empty list is the honest answer for a fresh home.
 *
 * The `--model <id>` flag accepts any id at launch/one-shot time regardless of
 * this list; the list is a best-effort convenience, not an allow-list.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { HarnessContext, ModelInfo, ModelRegistry } from '@terminull/adapter-sdk';

/** Options for {@link createAgyModelRegistry}. */
export interface AgyModelRegistryOptions {
  /** Override the `.gemini` home (defaults to `<ctx.home ?? homedir>/.gemini`). */
  geminiHome?: string;
  /**
   * Override the settings file scanned for a configured `model` (defaults to
   * `<geminiHome>/settings.json`).
   */
  settingsPath?: string;
}

function settingsPathOf(opts: AgyModelRegistryOptions, ctx?: HarnessContext): string {
  if (opts.settingsPath) return opts.settingsPath;
  const geminiHome = opts.geminiHome ?? path.join(ctx?.home ?? os.homedir(), '.gemini');
  return path.join(geminiHome, 'settings.json');
}

/** Read the `.model` string from a settings JSON file, or null if absent/unreadable. */
async function readConfiguredModel(file: string): Promise<string | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const model = (parsed as Record<string, unknown>)['model'];
  return typeof model === 'string' && model.length > 0 ? model : null;
}

/**
 * Create an agy model registry. `list` returns the single configured model
 * (source `'configured'`) when one is present in settings, else `[]`. It never
 * shells out to `agy models`.
 */
export function createAgyModelRegistry(opts: AgyModelRegistryOptions = {}): ModelRegistry {
  return {
    async list(ctx?: HarnessContext): Promise<ModelInfo[]> {
      const configured = await readConfiguredModel(settingsPathOf(opts, ctx));
      if (!configured) return [];
      return [{ id: configured, label: configured, source: 'configured' }];
    },
  };
}
