# terminull-plugin-obsidian-warm

An example **theme** plugin for [Terminull](../../README.md). It contributes
**Obsidian Warm** — a warm-neutral dark theme (amber accent over near-black
browns, control-tower heritage) that overrides the web app's `--tn-*` design
tokens.

This is one of three reference plugins that demonstrate the contribution
contract; it passes `terminull plugins validate` out of the box.

## Anatomy

| File                    | Role                                                                                                |
| ----------------------- | --------------------------------------------------------------------------------------------------- |
| `terminull.plugin.json` | The manifest — one `themes` contribution, `kind: "dark"`, both `en`+`ko` labels (the i18n rule).    |
| `theme.json`            | The contribution module — a map of `--tn-*` token overrides. Omitted tokens inherit the base theme. |
| `package.json`          | npm packaging (name `terminull-plugin-*`, MIT).                                                     |

## Validate

```sh
terminull plugins validate .
# or, from a clone of the monorepo:
node --test test.mjs
```

## Extend, never fork core

A theme changes only token values. It cannot execute code or reach outside its
own directory — the validator's module jail enforces that. To change anything
the tokens do not cover, contribute a different point (see the plugin authoring
kit at `docs/plugin-authoring/`), never patch Terminull core.
