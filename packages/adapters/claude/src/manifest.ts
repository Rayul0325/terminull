/**
 * The Claude Code plugin manifest. Structurally identical to any third-party
 * plugin (dogfooding): it contributes one adapter (`claude`) and one keymap
 * (`claude-default`), with plugin-relative module paths the runtime loads lazily.
 */
import type { PluginManifest } from '@terminull/shared';

export const manifest: PluginManifest = {
  name: 'terminull-plugin-claude',
  version: '0.0.0',
  pluginApi: '^1',
  displayName: { en: 'Claude Code', ko: 'Claude Code' },
  contributes: {
    adapters: [
      {
        id: 'claude',
        module: './adapter.js',
        displayName: { en: 'Claude Code', ko: 'Claude Code' },
      },
    ],
    keymaps: [
      {
        id: 'claude-default',
        module: './keymap.js',
        label: { en: 'Claude Code default keys', ko: 'Claude Code 기본 키' },
      },
    ],
  },
};
