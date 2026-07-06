# terminull-plugin-broken (intentionally invalid)

This directory is **deliberately broken**. It is the negative half of the plugin
validation gate: `terminull plugins validate` (and the test in
`packages/plugin-api/src/examples.test.ts`) must FAIL on it with _actionable_
messages — not a generic "invalid".

Two seeded defects, each schema-valid but caught by a later check:

| Defect                                           | Code                      | Actionable message points at                                 |
| ------------------------------------------------ | ------------------------- | ------------------------------------------------------------ |
| `pluginApi: "^2"` — wrong major (host API is v1) | `plugin_api_incompatible` | `pluginApi` → "use e.g. `^1`"                                |
| `module: "./theme.json"` — file never created    | `module_missing`          | `contributes.themes[0].module` → "create it or fix the path" |

Do **not** add a `theme.json` here and do **not** change `pluginApi` — that
would make the fixture pass and silently delete the gate's negative coverage.
