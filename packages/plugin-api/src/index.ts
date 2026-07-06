/**
 * `terminull-plugin-api` — the PUBLIC plugin contract package.
 *
 * This entry point is PURE (zod only): it is re-exported by
 * `@terminull/shared` and therefore ships inside the web bundle. The
 * node-flavoured directory validator lives behind the
 * `terminull-plugin-api/validate` subpath and must never be imported here.
 */
export * from './manifest.js';
export * from './range.js';
