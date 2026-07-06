# Terminull example plugins

Reference plugins that demonstrate the [plugin contract](../docs/plugin-authoring/SKILL.md).
Each is a real, npm-shaped package (`package.json`, `terminull.plugin.json`,
`LICENSE`). They are **not** workspace members — they are validated by path from
`packages/plugin-api/src/examples.test.ts`, and each also carries a
self-contained `node --test test.mjs`.

| Directory                                                            | Point     | What it shows                                                                                           |
| -------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------- |
| [`terminull-plugin-obsidian-warm`](./terminull-plugin-obsidian-warm) | `themes`  | A warm-neutral dark theme as `--tn-*` token overrides.                                                  |
| [`terminull-plugin-scratchpad`](./terminull-plugin-scratchpad)       | `panels`  | A markdown sidebar panel — and its test **dogfoods the real `PluginHost`** loader.                      |
| [`terminull-plugin-locale-ja`](./terminull-plugin-locale-ja)         | `locales` | The full Japanese (`ja`) translation of the core UI keys. Core ships ko+en; ja is a plugin.             |
| [`terminull-plugin-broken`](./terminull-plugin-broken)               | —         | **Intentionally invalid.** The validator must FAIL on it with actionable errors (gate's negative half). |

## Run the whole set

From a built monorepo (`pnpm --filter terminull-plugin-api build` first — the
example self-tests import the compiled validator by relative path):

```sh
# the canonical, CI-covered pass (validates all three + asserts the broken one fails):
pnpm --filter terminull-plugin-api test

# or each example on its own:
node --test examples/terminull-plugin-obsidian-warm/test.mjs
node --test examples/terminull-plugin-scratchpad/test.mjs
node --test examples/terminull-plugin-locale-ja/test.mjs
```

## The one rule

Never modify Terminull core. A plugin extends the app **only** through the eight
declarative contribution points. `terminull plugins validate <dir>` is the
machine oracle — loop on it until it is green.
