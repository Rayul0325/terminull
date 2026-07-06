# Terminull plugin authoring (AGENTS.md)

**NEVER modify Terminull core — extend ONLY via the eight contribution points below; run `terminull plugins validate <dir>` after every edit and loop until it is green (it is the machine oracle). Green validate = done; anything else = keep fixing.**

This is the codex/gemini-facing mirror of `SKILL.md` in the same directory. It is
self-contained: the full manifest schema, the semver gate, one example per point,
and every error code are inlined here so you can grep this one file.

A Terminull plugin is an npm package (`terminull-plugin-*`) with a declarative
manifest and lazily-loaded modules. It never patches app source and cannot reach
outside its own directory — the validator's module jail enforces that. An
incompatible or malformed plugin is disabled with a reason; it never half-loads.

## Loop

1. `terminull plugins scaffold <point> <name>` → a `terminull-plugin-<name>/`
   that already validates (first-class: `theme`, `panel`, `locale`; generic
   template for the other five points).
2. Edit the manifest + module.
3. `terminull plugins validate <dir>` (`--json` for machine output).
4. Not green? Use each issue's `code` + `at` (table at the bottom), fix, GOTO 3.

Programmatic equivalents (Node-only): `validatePluginDir` from
`@terminull/plugin-api/validate`; `scaffoldPlugin` from
`@terminull/plugin-api/scaffold`.

## Eight contribution points

Each contribution: unique `id` per point, plugin-relative `module`, a localized
label. Only `adapters` runs a factory; the rest are validated metadata.

| Point          | Label field   | Extra required      | Optional                                                  |
| -------------- | ------------- | ------------------- | --------------------------------------------------------- |
| `adapters`     | `displayName` | —                   | — (module default-exports a zero-arg ToolAdapter factory) |
| `renderers`    | `displayName` | —                   | `mimeTypes: string[]`                                     |
| `panels`       | `title`       | —                   | `location: sidebar\|main\|statusbar`                      |
| `themes`       | `label`       | `kind: light\|dark` | —                                                         |
| `locales`      | `label`       | `locale: string`    | —                                                         |
| `keymaps`      | `label`       | —                   | —                                                         |
| `harnessForms` | `title`       | —                   | `targets: string[]`                                       |
| `commands`     | `title`       | —                   | —                                                         |

## Manifest schema

Discovery order: `terminull.plugin.json` → `terminull` field in `package.json` →
`package.json`. Every object is strict (unknown keys rejected). `LocalizedText`
requires both `en` and `ko`.

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://terminull.dev/schema/plugin-manifest-v1.json",
  "type": "object",
  "required": ["name", "version", "pluginApi", "contributes"],
  "additionalProperties": false,
  "properties": {
    "name": { "type": "string", "minLength": 1 },
    "version": { "type": "string", "minLength": 1 },
    "pluginApi": {
      "type": "string",
      "minLength": 1,
      "description": "semver range over host API major 1: '^1', '1', '>=1 <2'"
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
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "module", "displayName"],
      "properties": {
        "id": { "type": "string", "minLength": 1 },
        "module": { "type": "string", "minLength": 1 },
        "displayName": { "$ref": "#/$defs/localizedText" }
      }
    },
    "renderer": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "module", "displayName"],
      "properties": {
        "id": { "type": "string", "minLength": 1 },
        "module": { "type": "string", "minLength": 1 },
        "displayName": { "$ref": "#/$defs/localizedText" },
        "mimeTypes": { "type": "array", "items": { "type": "string", "minLength": 1 } }
      }
    },
    "panel": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "module", "title"],
      "properties": {
        "id": { "type": "string", "minLength": 1 },
        "module": { "type": "string", "minLength": 1 },
        "title": { "$ref": "#/$defs/localizedText" },
        "location": { "enum": ["sidebar", "main", "statusbar"] }
      }
    },
    "theme": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "module", "label", "kind"],
      "properties": {
        "id": { "type": "string", "minLength": 1 },
        "module": { "type": "string", "minLength": 1 },
        "label": { "$ref": "#/$defs/localizedText" },
        "kind": { "enum": ["light", "dark"] }
      }
    },
    "locale": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "module", "locale", "label"],
      "properties": {
        "id": { "type": "string", "minLength": 1 },
        "module": { "type": "string", "minLength": 1 },
        "locale": { "type": "string", "minLength": 1 },
        "label": { "$ref": "#/$defs/localizedText" }
      }
    },
    "keymap": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "module", "label"],
      "properties": {
        "id": { "type": "string", "minLength": 1 },
        "module": { "type": "string", "minLength": 1 },
        "label": { "$ref": "#/$defs/localizedText" }
      }
    },
    "harnessForm": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "module", "title"],
      "properties": {
        "id": { "type": "string", "minLength": 1 },
        "module": { "type": "string", "minLength": 1 },
        "title": { "$ref": "#/$defs/localizedText" },
        "targets": { "type": "array", "items": { "type": "string", "minLength": 1 } }
      }
    },
    "command": {
      "type": "object",
      "additionalProperties": false,
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

## Semver gate

Host API major = **1**. `pluginApi` must admit it: caret `^1`, exact `1`/`1.0.0`,
or comparators `>=1 <2`. `^2`, `banana`, `""` FAIL (fail-closed). Use `^1`.

## One minimal manifest per point

Write the referenced module file next to the manifest (`{}` JSON or a stub
`export default {}` passes the existence/JSON checks).

```jsonc
// themes
{ "name": "terminull-plugin-x", "version": "0.1.0", "pluginApi": "^1",
  "contributes": { "themes": [ { "id": "x", "module": "./theme.json",
    "label": { "en": "X", "ko": "엑스" }, "kind": "dark" } ] } }
// panels
{ "name": "terminull-plugin-x", "version": "0.1.0", "pluginApi": "^1",
  "contributes": { "panels": [ { "id": "x", "module": "./panel.mjs",
    "title": { "en": "X", "ko": "엑스" }, "location": "sidebar" } ] } }
// locales
{ "name": "terminull-plugin-x", "version": "0.1.0", "pluginApi": "^1",
  "contributes": { "locales": [ { "id": "x", "module": "./ja.json", "locale": "ja",
    "label": { "en": "Japanese", "ko": "일본어", "ja": "日本語" } } ] } }
// adapters (default export = zero-arg factory)
{ "name": "terminull-plugin-x", "version": "0.1.0", "pluginApi": "^1",
  "contributes": { "adapters": [ { "id": "x", "module": "./adapter.mjs",
    "displayName": { "en": "X", "ko": "엑스" } } ] } }
// renderers
{ "name": "terminull-plugin-x", "version": "0.1.0", "pluginApi": "^1",
  "contributes": { "renderers": [ { "id": "x", "module": "./renderer.mjs",
    "displayName": { "en": "X", "ko": "엑스" }, "mimeTypes": ["text/markdown"] } ] } }
// keymaps
{ "name": "terminull-plugin-x", "version": "0.1.0", "pluginApi": "^1",
  "contributes": { "keymaps": [ { "id": "x", "module": "./keymap.json",
    "label": { "en": "X", "ko": "엑스" } } ] } }
// harnessForms
{ "name": "terminull-plugin-x", "version": "0.1.0", "pluginApi": "^1",
  "contributes": { "harnessForms": [ { "id": "x", "module": "./form.json",
    "title": { "en": "X", "ko": "엑스" }, "targets": ["settings.json"] } ] } }
// commands
{ "name": "terminull-plugin-x", "version": "0.1.0", "pluginApi": "^1",
  "contributes": { "commands": [ { "id": "x", "module": "./command.mjs",
    "title": { "en": "X", "ko": "엑스" } } ] } }
```

## Error codes (fix by `code` + `at`)

| `code`                      | Fix                                                                   |
| --------------------------- | --------------------------------------------------------------------- |
| `dir_not_found`             | Point at an existing plugin directory.                                |
| `manifest_missing`          | Add `terminull.plugin.json` or a `terminull` field in `package.json`. |
| `manifest_unparseable`      | Fix the manifest JSON syntax.                                         |
| `manifest_invalid`          | Schema violation; `at` is the exact field path. Match the schema.     |
| `plugin_api_incompatible`   | `pluginApi` excludes host v1 → use `^1`.                              |
| `module_path_escapes`       | Use a relative path inside the package (no `..`, no absolute).        |
| `module_missing`            | Create the `module` file or fix the path.                             |
| `module_json_invalid`       | Fix the `.json` module's JSON.                                        |
| `duplicate_contribution_id` | Make ids unique per point.                                            |
| `name_convention` (warning) | Advisory: prefer `terminull-plugin-*`. Never blocks.                  |

## Examples in this repo

`examples/terminull-plugin-obsidian-warm` (theme),
`examples/terminull-plugin-scratchpad` (panel; test dogfoods the real loader),
`examples/terminull-plugin-locale-ja` (full ja pack),
`examples/terminull-plugin-broken` (intentionally invalid — actionable FAIL).
