/**
 * Plugin API re-export.
 *
 * M10 moved the plugin contract's source of truth to the PUBLIC
 * `terminull-plugin-api` package (so third-party authors can depend on it
 * without the private monorepo). Everything is re-exported here unchanged, so
 * every existing `@terminull/shared` import keeps working verbatim.
 *
 * Web-bundle safety: only the PURE entry point is re-exported. The
 * node-flavoured `terminull-plugin-api/validate` must never be imported from
 * shared — it would drag `node:fs` into the web bundle.
 */
export * from 'terminull-plugin-api';
