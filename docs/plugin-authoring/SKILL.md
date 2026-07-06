---
name: terminull-plugin-authoring
description: Author a Terminull plugin — extend the panel through its eight declarative contribution points (adapters, renderers, panels, themes, locales, keymaps, harnessForms, commands) without ever modifying core. Use when creating, editing, or debugging a terminull-plugin-* package, a plugin manifest (terminull.plugin.json), a theme/panel/locale contribution, or when `terminull plugins validate` reports errors. Contains the full manifest JSON-schema, the semver gate rules, every validation error code, and one minimal example per contribution point.
---

**NEVER modify Terminull core — extend ONLY via the eight contribution points below; run `terminull plugins validate <dir>` after every edit and loop until it is green (it is the machine oracle). Green validate = done; anything else = keep fixing.**

A Terminull plugin is an npm package (`terminull-plugin-*`) described by a
declarative manifest with lazily-loaded modules. First-party features are built
the same way (dogfooding), so your plugin is structurally equal to a built-in.
The plugin never patches app source, never reaches outside its own directory
(the validator's module jail enforces this), and is disabled — honestly, with a
reason — if it is incompatible or malformed.

## The loop (do this, not vibes)

1. `terminull plugins scaffold <point> <name>` → writes `terminull-plugin-<name>/`
   that already validates. (First-class templates: `theme`, `panel`, `locale`.
   The other five points share a generic template.)
2. Edit the manifest + module for your contribution.
3. `terminull plugins validate <dir>` (add `--json` for machine output).
4. Not green? Read the `code` + `at` of each issue below, fix, GOTO 3.

## The eight contribution points

Every contribution has a unique `id` (per point), a plugin-relative `module`
path, and a localized label. Only `adapters` has a live factory contract; the
other seven are validated metadata stored for web/server consumers.

| Point | Label field | Extra required | Optional | Module is |
| --- | --- | --- | --- | --- |
| `adapters` | `displayName` | — | — | a `.mjs`/`.js` whose **default export is a zero-arg factory** returning a `ToolAdapter` |
| `renderers` | `displayName` | — | `mimeTypes: string[]` | a module (renders transcript/output) |
| `panels` | `title` | — | `location: sidebar\|main\|statusbar` | a data module (no code run at registration) |
| `themes` | `label` | `kind: light\|dark` | — | a `.json` of `--tn-*` token overrides |
| `locales` | `label` | `locale: string` (BCP-47) | — | a `.json` message pack |
| `keymaps` | `label` | — | — | a `.json`/module of key bindings |
| `harnessForms` | `title` | — | `targets: string[]` | a declarative form module |
| `commands` | `title` | — | — | a module exposing an action |

## Manifest JSON-schema (the whole contract)

`terminull.plugin.json` (preferred), else a `terminull` field in `package.json`,
else `package.json` itself. Every object below is **strict** — unknown keys are
rejected. `LocalizedText` **must** carry both `en` and `ko` (extra locales
allowed).

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://terminull.dev/schema/plugin-manifest-v1.json",
  "title": "Terminull plugin manifest (pluginApi 1)",
  "type": "object",
  "required": ["name", "version", "pluginApi", "contributes"],
  "additionalProperties": false,
  "properties": {
    "name": { "type": "string", "minLength": 1 },
    "version": { "type": "string", "minLength": 1 },
    "pluginApi": {
      "type": "string",
      "minLength": 1,
      "description": "semver RANGE over the host API major (currently 1): '^1', '1', '>=1 <2'"
    },
    "displayName": { "$ref": "#/$defs/localizedText" },
    "contributes": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "adapters": { "type": "array", "items": { "$ref": "#/$defs/adapter" } },
        "renderers": { "type": "array", "items": { "$ref": "#/$defs/renderer" } },
        "panels": { "type": "array", "items": { "$ref": "#/$defs/panel" } },
        "themes": { "type": "array", "items": { "$ref": "#/$defs/theme" } },
        "locales": { "type": "array", "items": { "$ref": "#/$defs/locale" } },
        "keymaps": { "type": "array", "items": { "$ref": "#/$defs/keymap" } },
        "harnessForms": { "type": "array", "items": { "$ref": "#/$defs/harnessForm" } },
        "commands": { "type": "array", "items": { "$ref": "#/$defs/command" } }
      }
    }
  },
  "$defs": {
    "localizedText": {
      "type": "object",
      "required": ["en", "ko"],
      "properties": {
        "en": { "type": "string", "minLength": 1 },
        "ko": { "type": "string", "minLength": 1 }
      },
      "additionalProperties": { "type": "string" }
    },
    "adapter": {
      "type": "object", "additionalProperties": false,
      "required": ["id", "module", "displayName"],
      "properties": {
        "id": { "type": "string", "minLength": 1 },
        "module": { "type": "string", "minLength": 1 },
        "displayName": { "$ref": "#/$defs/localizedText" }
      }
    },
    "renderer": {
      "type": "object", "additionalProperties": false,
      "required": ["id", "module", "displayName"],
      "properties": {
        "id": { "type": "string", "minLength": 1 },
        "module": { "type": "string", "minLength": 1 },
        "displayName": { "$ref": "#/$defs/localizedText" },
        "mimeTypes": { "type": "array", "items": { "type": "string", "minLength": 1 } }
      }
    },
    "panel": {
      "type": "object", "additionalProperties": false,
      "required": ["id", "module", "title"],
      "properties": {
        "id": { "type": "string", "minLength": 1 },
        "module": { "type": "string", "minLength": 1 },
        "title": { "$ref": "#/$defs/localizedText" },
        "location": { "enum": ["sidebar", "main", "statusbar"] }
      }
    },
    "theme": {
      "type": "object", "additionalProperties": false,
      "required": ["id", "module", "label", "kind"],
      "properties": {
        "id": { "type": "string", "minLength": 1 },
        "module": { "type": "string", "minLength": 1 },
        "label": { "$ref": "#/$defs/localizedText" },
        "kind": { "enum": ["light", "dark"] }
      }
    },
    "locale": {
      "type": "object", "additionalProperties": false,
      "required": ["id", "module", "locale", "label"],
      "properties": {
        "id": { "type": "string", "minLength": 1 },
        "module": { "type": "string", "minLength": 1 },
        "locale": { "type": "string", "minLength": 1 },
        "label": { "$ref": "#/$defs/localizedText" }
      }
    },
    "keymap": {
      "type": "object", "additionalProperties": false,
      "required": ["id", "module", "label"],
      "properties": {
        "id": { "type": "string", "minLength": 1 },
        "module": { "type": "string", "minLength": 1 },
        "label": { "$ref": "#/$defs/localizedText" }
      }
    },
    "harnessForm": {
      "type": "object", "additionalProperties": false,
      "required": ["id", "module", "title"],
      "properties": {
        "id": { "type": "string", "minLength": 1 },
        "module": { "type": "string", "minLength": 1 },
        "title": { "$ref": "#/$defs/localizedText" },
        "targets": { "type": "array", "items": { "type": "string", "minLength": 1 } }
      }
    },
    "command": {
      "type": "object", "additionalProperties": false,
      "required": ["id", "module", "title"],
      "properties": {
        "id": { "type": "string", "minLength": 1 },
        "module": { "type": "string", "minLength": 1 },
        "title": { "$ref": "#/$defs/localizedText" }
      }
    }
  }
}
```

## The semver gate (`pluginApi`)

The host runs API major **1**. Your `pluginApi` range must admit it, or the
whole plugin is disabled. Supported forms (a tiny built-in checker, fail-closed
on anything else): caret `^1`; exact `1` / `1.0.0`; space-separated comparators
`>=1 <2`. `^2`, `banana`, and `""` all FAIL. Use `^1`.

## One minimal example per point

Each block is a complete `terminull.plugin.json`. Write the referenced module
file next to it (a `{}` JSON or a stub `export default {}` is enough to pass the
existence/JSON checks; fill in real content after).

```jsonc
// themes — module is a JSON of --tn-* token overrides
{ "name": "terminull-plugin-x", "version": "0.1.0", "pluginApi": "^1",
  "contributes": { "themes": [
    { "id": "x", "module": "./theme.json",
      "label": { "en": "X", "ko": "엑스" }, "kind": "dark" } ] } }

// panels — declarative UI surface
{ "name": "terminull-plugin-x", "version": "0.1.0", "pluginApi": "^1",
  "contributes": { "panels": [
    { "id": "x", "module": "./panel.mjs",
      "title": { "en": "X", "ko": "엑스" }, "location": "sidebar" } ] } }

// locales — a message pack for one locale code
{ "name": "terminull-plugin-x", "version": "0.1.0", "pluginApi": "^1",
  "contributes": { "locales": [
    { "id": "x", "module": "./ja.json", "locale": "ja",
      "label": { "en": "Japanese", "ko": "일본어", "ja": "日本語" } } ] } }

// adapters — default export is a zero-arg ToolAdapter factory
{ "name": "terminull-plugin-x", "version": "0.1.0", "pluginApi": "^1",
  "contributes": { "adapters": [
    { "id": "x", "module": "./adapter.mjs",
      "displayName": { "en": "X", "ko": "엑스" } } ] } }

// renderers — optional mimeTypes
{ "name": "terminull-plugin-x", "version": "0.1.0", "pluginApi": "^1",
  "contributes": { "renderers": [
    { "id": "x", "module": "./renderer.mjs",
      "displayName": { "en": "X", "ko": "엑스" }, "mimeTypes": ["text/markdown"] } ] } }

// keymaps
{ "name": "terminull-plugin-x", "version": "0.1.0", "pluginApi": "^1",
  "contributes": { "keymaps": [
    { "id": "x", "module": "./keymap.json",
      "label": { "en": "X", "ko": "엑스" } } ] } }

// harnessForms — optional targets
{ "name": "terminull-plugin-x", "version": "0.1.0", "pluginApi": "^1",
  "contributes": { "harnessForms": [
    { "id": "x", "module": "./form.json",
      "title": { "en": "X", "ko": "엑스" }, "targets": ["settings.json"] } ] } }

// commands
{ "name": "terminull-plugin-x", "version": "0.1.0", "pluginApi": "^1",
  "contributes": { "commands": [
    { "id": "x", "module": "./command.mjs",
      "title": { "en": "X", "ko": "엑스" } } ] } }
```

## Validation error codes (fix by `code` + `at`)

`validate` returns `{ ok, manifestSource, manifest, errors[], warnings[] }`.
`ok` is true only when `errors` is empty; warnings never flip `ok`.

| `code` | Meaning → fix |
| --- | --- |
| `dir_not_found` | The path is not a directory. Point at the plugin folder. |
| `manifest_missing` | No `terminull.plugin.json` and no `terminull` field in `package.json`. Add one. |
| `manifest_unparseable` | The manifest is not valid JSON. Fix the syntax at the reported file. |
| `manifest_invalid` | A schema violation; `at` is the exact field path (e.g. `contributes.themes[0].kind`). Make it match the schema above. |
| `plugin_api_incompatible` | `pluginApi` range excludes host v1. Use `^1`. |
| `module_path_escapes` | `module` is absolute or climbs out of the plugin dir. Use a relative path inside the package. |
| `module_missing` | The `module` file does not exist. Create it or fix the path. |
| `module_json_invalid` | A `.json` module does not parse. Fix its JSON. |
| `duplicate_contribution_id` | Two contributions share an `id` within one point. Ids must be unique per point. |
| `name_convention` (**warning**) | Name is not `terminull-plugin-*`. Advisory only — never blocks. |

## Working examples in this repo

- `examples/terminull-plugin-obsidian-warm` — a theme (token overrides).
- `examples/terminull-plugin-scratchpad` — a panel (its test loads through the real `PluginHost`).
- `examples/terminull-plugin-locale-ja` — a full `ja` locale pack.
- `examples/terminull-plugin-broken` — intentionally invalid; shows what an actionable FAIL looks like.

Programmatic use: `import { validatePluginDir } from '@terminull/plugin-api/validate'`
and `import { scaffoldPlugin } from '@terminull/plugin-api/scaffold'` (both Node-only).
The pure entry `@terminull/plugin-api` exports the schemas + `rangeSatisfies`.
