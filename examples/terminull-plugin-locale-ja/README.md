# terminull-plugin-locale-ja

An example **locale** plugin for [Terminull](../../README.md). It ships **`ja`
(Japanese)** — a full translation of the core web UI message keys.

> **Honest scope:** Terminull core ships only `ko` + `en`. Japanese lives here,
> in an example plugin, to demonstrate the `locales` contribution point. Installing
> this plugin adds `ja` as a selectable language; it never edits core.

## Anatomy

| File | Role |
| --- | --- |
| `terminull.plugin.json` | The manifest — one `locales` contribution (`locale: "ja"`, tri-lingual label). |
| `ja.json` | The contribution module — every key from `packages/web/src/i18n/locales/en.json`, translated to natural Japanese, with all `{{interpolation}}` tokens preserved verbatim. |
| `package.json` | npm packaging. |

## Keeping it in sync

The `ja.json` key set must exactly mirror the core `en.json`. That parity is a
test — see `packages/plugin-api/src/examples.test.ts`. When core adds a key,
this pack must add it too, or the test (and `terminull plugins validate`, for a
malformed file) fails.

```sh
terminull plugins validate .
# or, from a clone of the monorepo:
node --test test.mjs
```
