/**
 * The generic plugin's manifest. Terminull's first dogfooded plugin: it
 * declares the same {@link PluginManifest} shape a third-party plugin would,
 * contributing one adapter (`generic-pty`) and one keymap (`generic-default`).
 * Module paths are plugin-relative and resolved lazily by the runtime.
 */
import type { PluginManifest } from '@terminull/shared';

export const manifest: PluginManifest = {
  name: 'terminull-plugin-generic',
  version: '0.0.0',
  pluginApi: '^1',
  displayName: { en: 'Generic PTY', ko: '일반 PTY' },
  contributes: {
    adapters: [
      {
        id: 'generic-pty',
        module: './adapter.js',
        displayName: { en: 'Generic CLI', ko: '일반 CLI' },
      },
    ],
    keymaps: [
      {
        id: 'generic-default',
        module: './keymap.js',
        label: { en: 'Generic default keys', ko: '일반 기본 키' },
      },
    ],
  },
};
