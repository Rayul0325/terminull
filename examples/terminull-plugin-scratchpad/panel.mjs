/**
 * Scratchpad panel contribution module.
 *
 * Panels are declarative in the v1 contract: the plugin host stores this
 * metadata and a future web layer mounts the panel from it. Keeping the module
 * a plain data export means the plugin needs no build step and cannot execute
 * code at registration time (the host never imports non-adapter modules).
 *
 * A real web host would read `defaultContent` into a local-storage-backed
 * markdown textarea keyed by `id`.
 */
export default {
  id: 'scratchpad',
  location: 'sidebar',
  /** How the panel wants to render (advisory metadata for the web host). */
  render: 'markdown-textarea',
  /** Seed text shown the first time the panel opens. */
  defaultContent: '# Scratchpad\n\nJot notes here. Nothing leaves your machine.\n',
  /** Persist edits under this key (host decides the storage backend). */
  storageKey: 'terminull.scratchpad',
};
