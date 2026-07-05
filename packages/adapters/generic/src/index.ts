/**
 * `@terminull/adapter-generic` — the generic PTY plugin (first dogfooded
 * plugin). Exports the adapter factory, its keymap, and the plugin manifest.
 */
export { createGenericAdapter, GenericPtyDriver } from './adapter.js';
export { default } from './adapter.js';
export { genericKeymap } from './keymap.js';
export { manifest } from './manifest.js';
