# terminull-plugin-scratchpad

An example **panel** plugin for [Terminull](../../README.md). It contributes a
markdown **Scratchpad** surface that a web host mounts in the sidebar.

This example does double duty: besides passing `terminull plugins validate`, its
self-test **dogfoods the real plugin runtime** — the same `PluginHost` the
server uses loads this directory and registers the panel (see `test.mjs`).

## Anatomy

| File | Role |
| --- | --- |
| `terminull.plugin.json` | The manifest — one `panels` contribution (`location: "sidebar"`, `en`+`ko` titles). |
| `panel.mjs` | The contribution module — declarative panel metadata. Panels carry **no executable registration code**; the host stores the metadata and a web layer renders from it. |
| `package.json` | npm packaging. |

## Validate + dogfood

```sh
terminull plugins validate .
# or, from a clone of the monorepo (also exercises PluginHost):
node --test test.mjs
```

## Why a data module

The v1 host never imports non-adapter modules at registration — it only reads
their declared metadata. That keeps panel registration side-effect free and is
why `panel.mjs` is a plain `export default { … }` with no imports.
