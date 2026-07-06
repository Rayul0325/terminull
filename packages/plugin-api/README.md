# terminull-plugin-api

The public plugin contract for [Terminull](https://github.com/terminull/terminull) —
manifest types + zod schemas for the eight contribution points, the `pluginApi`
semver gate, a programmatic plugin-directory **validator**, and a **scaffolder**.

Terminull is extended by plugins, never by patching core. This package is what a
plugin author depends on to author and check a plugin against the exact contract
the runtime enforces.

```sh
npm install terminull-plugin-api
```

## Three entry points

| Import                           | Runtime                    | Contents                                                                                                                                                          |
| -------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `terminull-plugin-api`          | pure (zod only — web-safe) | `PluginManifestSchema` + the 8 `*ContributionSchema`, `LocalizedTextSchema`, `CONTRIBUTION_POINTS`, `PLUGIN_API_VERSION`, and `rangeSatisfies` (the semver gate). |
| `terminull-plugin-api/validate` | Node (`node:fs`)           | `validatePluginDir(dir)` — the machine oracle behind `terminull plugins validate`.                                                                                |
| `terminull-plugin-api/scaffold` | Node (`node:fs`)           | `scaffoldPlugin({ point, name, targetDir })` — writes a validate-green package.                                                                                   |

The `.` entry is pure so it can ship inside a browser bundle; the `/validate`
and `/scaffold` subpaths touch the filesystem and are Node-only.

## Validate a plugin directory

```ts
import { validatePluginDir } from 'terminull-plugin-api/validate';

const res = validatePluginDir('./terminull-plugin-my-theme');
if (!res.ok) {
  for (const e of res.errors) console.error(`[${e.code}] ${e.at ?? ''}: ${e.message}`);
}
```

`res` is `{ ok, manifestSource, manifest, errors[], warnings[] }`. `ok` is true
only when `errors` is empty; warnings (e.g. the `terminull-plugin-*` name
convention) never flip `ok`. Every error carries a machine `code` and, where
relevant, an `at` path (`contributes.themes[0].module`) — actionable, not just
"invalid". See the code table in
[`docs/plugin-authoring/SKILL.md`](https://github.com/terminull/terminull/blob/main/docs/plugin-authoring/SKILL.md).

## Scaffold a new plugin

```ts
import { scaffoldPlugin } from 'terminull-plugin-api/scaffold';

const { dir } = scaffoldPlugin({ point: 'themes', name: 'my-theme', targetDir: '.' });
// → ./terminull-plugin-my-theme, already passing validatePluginDir
```

First-class templates: `themes`, `panels`, `locales`. The other five points
(`adapters`, `renderers`, `keymaps`, `harnessForms`, `commands`) share a generic
template. Singular point names (`theme`) are accepted via
`normalizeScaffoldPoint`.

## The semver gate

```ts
import { rangeSatisfies, PLUGIN_API_VERSION } from 'terminull-plugin-api';
rangeSatisfies('^1'); // true  (host API major = PLUGIN_API_VERSION = 1)
rangeSatisfies('^2'); // false (fail-closed)
```

This is the exact function the Terminull runtime uses to admit or disable a
plugin — authors check against identical code.

## The contract in one page

The eight contribution points, the manifest JSON-schema, the semver rules, and
one example per point live in the authoring kit:

- Claude agents: `docs/plugin-authoring/SKILL.md`
- codex / gemini: `docs/plugin-authoring/AGENTS.md`
- one-screen summary: `llms.txt` at the repo root

## License

MIT.
