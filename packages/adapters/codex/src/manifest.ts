/**
 * The Codex CLI plugin manifest. Structurally identical to any third-party
 * plugin (dogfooding): it contributes one adapter (`codex`) and one keymap
 * (`codex-default`), with plugin-relative module paths the runtime loads lazily.
 */
import type { PluginManifest } from '@terminull/shared';

export const manifest: PluginManifest = {
  name: 'terminull-plugin-codex',
  version: '0.0.0',
  pluginApi: '^1',
  displayName: { en: 'Codex', ko: 'Codex' },
  contributes: {
    adapters: [
      {
        id: 'codex',
        module: './adapter.js',
        displayName: { en: 'Codex', ko: 'Codex' },
      },
    ],
    keymaps: [
      {
        id: 'codex-default',
        module: './keymap.js',
        label: { en: 'Codex default keys', ko: 'Codex 기본 키' },
      },
    ],
  },
};
