/**
 * The Antigravity (`agy`) plugin manifest. Structurally identical to any
 * third-party plugin (dogfooding): it contributes one adapter (`agy`) and one
 * keymap (`agy-default`), with plugin-relative module paths the runtime loads
 * lazily.
 *
 * NOTE: this object is intentionally NOT annotated with `PluginManifest` from
 * `@terminull/shared`. This package only links `@terminull/adapter-sdk` in its
 * node_modules; adding `@terminull/shared` would require `pnpm install`, which
 * is out of scope for this package build. The manifest's validity is enforced
 * at runtime by the PluginHost's zod schema and asserted by the registration
 * test (`index.test.ts`) — a stronger guarantee than the compile-time shape.
 */
export const manifest = {
  name: 'terminull-plugin-agy',
  version: '0.0.0',
  pluginApi: '^1',
  displayName: { en: 'Antigravity (agy)', ko: 'Antigravity (agy)' },
  contributes: {
    adapters: [
      {
        id: 'agy',
        module: './adapter.js',
        displayName: { en: 'Antigravity (agy)', ko: 'Antigravity (agy)' },
      },
    ],
    keymaps: [
      {
        id: 'agy-default',
        module: './keymap.js',
        label: { en: 'Antigravity default keys', ko: 'Antigravity 기본 키' },
      },
    ],
  },
} as const;
