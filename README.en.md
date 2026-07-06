# Terminull

**Terminull — one panel for every CLI coding agent.** Launch, drive, record, and
manage Claude Code, Codex, agy (Antigravity), and any command-line tool from a
single screen. It is a local-first (127.0.0.1) pnpm + TypeScript monorepo — a
shared core, per-tool adapters, a PTY session host, a server, a CLI, and a React
web panel. Every string is dual-locale (Korean / English).

> 한국어: [README.md](./README.md)

**Status: v0.1.0 (first public release).** Exactly TWO packages are published to
npm — the product entry `terminull` (this CLI) and the plugin-authoring
types/validator library `@terminull/plugin-api`. Every other workspace package
stays private.

---

## Trust first — exactly what `npx terminull setup` touches

Terminull **injects hooks** into each coding agent's config so the panel can
receive session events. What it adds, where, and how is spelled out file-by-file
below. **Don't guess — trust this table; it is exactly what the code does.**

### Per-tool injection (file by file)

| Tool | Files touched | Exactly what is added | Original handling |
| --- | --- | --- | --- |
| **Claude Code** | `~/.claude/terminull/hooks/*.sh` (new dir) | Copies 8 hook scripts (7 event hooks + the shared `terminull-lib.sh`) | New directory — no pre-existing files |
| **Claude Code** | `~/.claude/settings.json` | Adds 7 entries under `hooks`: `SessionStart`, `UserPromptSubmit`, `PreToolUse` (matcher `AskUserQuestion`), `PostToolUse` (matcher `ExitPlanMode`), `Notification`, `Stop`, `SessionEnd`. **Your existing hooks/settings keep their order and values**; ours are appended after | Original backed up verbatim to `settings.json.terminull.bak-<timestamp>`, then atomic replace |
| **Codex** | `~/.codex/terminull/hooks/*.sh` (new dir) | Copies 2 notify wrapper scripts (`terminull-codex-notify.sh` + `terminull-lib.sh`) | New directory |
| **Codex** | `~/.codex/config.toml` | **A single line only** — surgically edits the top-level `notify = [...]` array. Our wrapper goes at the front, then chain-execs the original notify client → Codex Desktop behaviour unchanged. If no array exists, a fresh `notify` line is inserted before the first `[table]` header | Original backed up to `config.toml.terminull.bak-<timestamp>`. **Your `[projects."..."]` trust tables (per-directory `trust_level`) survive byte-identically** — the TOML is never reserialized |
| **agy (Antigravity)** | — none — | agy exposes no hooks. Terminull only detects and drives it; it **touches no config file** (honest limitation) | N/A |

### Every change is consent-gated (diff preview)

`setup` **renders a dry-run diff per tool first**, asks for individual consent
(stdin `y/N`) per tool, and only then writes. The preview is produced by the
injector's real `plan()`, so what you see on screen equals what lands on disk.
`--yes` accepts every consent at once (for CI / automation).

Each injection fact (the exact bytes added, sha256 before/after, backup path) is
recorded in the provenance ledger `~/.terminull/injected.json`. That ledger is
what guarantees byte-level restore.

### Complete removal — byte-identical restore

```sh
terminull eject [claude|codex]   # remove one tool
terminull uninstall              # remove all tools + clean up the service
```

The eject algorithm reads the ledger and:

1. **File untouched since install** → **restore the backup bytes exactly**
   (sha256 match guaranteed for both `settings.json` and `config.toml`).
2. **A file we created** and left unmodified → unlink it.
3. **You edited the file** (drift) → surgically strip only our exact fragment
   and **leave your edits intact**.
4. Our fragment is gone or altered → **leave the file untouched, warn only**.
   We never clobber user edits.

`uninstall` does NOT delete the data directory (`~/.terminull`). To remove it you
must pass `--purge` plus an interactive confirmation (`--yes` alone keeps your
data).

> The core injection primitives (JSON append-dedup, TOML single-line surgery,
> the provenance ledger) and adapter injectors are golden-tested against fake
> homes (temp dirs). **The real `~/.claude` / `~/.codex` are never touched in
> tests.**

---

## Quickstart

```sh
# Not yet published to npm — from the local workspace:
corepack enable
pnpm install
pnpm -r build

# After publish (v0.1.0):
npx terminull setup     # detect → diff preview → consent → inject → launch panel
```

`setup` runs, in order: engine check (Node ≥ 22) → detect installed tools
(claude/codex/agy binaries + `--version`; missing = honest skip) → per-tool diff
preview + individual consent → inject + ledger record → install the local panel
service → synthetic-event round-trip healthcheck → print the panel URL.

`terminull doctor` diagnoses issues: environment (Node · PATH), state dir ·
`server.json` · process liveness, socket reachability, service status, version,
and a bundle-integrity hash — each reported red/green independently.

---

## What works today (shipped features only)

- **Many CLI agents in one panel** — dockview workspace, per-tool renderer
  registry, live PTY terminal, ko/en i18n (M6).
- **Deep adapters** — Claude Code (transcript parsing · driving · hook
  injection), Codex (rollout parser · `exec --json` driving · token usage ·
  notify injection) (M4 · M7).
- **Agent management + approvals** — supervisor brain, proposed-action approval
  inbox, permission toggles, tool-usage gauge (M7).
- **Multi-machine** — install an SSH stdio-relay agent on remote hosts
  (`enroll`), machine registry, machine-tagged sessions, web machine badges +
  staleness chips (M8).
- **Harness editing** — sha-locked optimistic writes with backup rotation to
  safely diff/edit tool config from the panel, account center, session-create
  stepper, keybinding editor, mobile shell (M9).
- **Install/remove + plugins + desktop shell** — the trust-first inject/eject
  above, the plugin validator, an Electron thin-shell skeleton (M10, this
  release).

## Multi-machine

```sh
terminull enroll <ssh-host> [--label <name>]   # install the relay agent remotely
terminull enroll <ssh-host> --remove           # complete reversal
terminull machines status                       # registered machine status
```

The remote footprint is confined to `~/.terminull-agent/`, and `VERSION` is
written **last** so its presence == a complete install (re-running is an
idempotent upgrade). Every remote byte goes through the SSH relay seam.

## Plugins (authoring kit)

Plugins **never modify core** — they extend only through the 8 contribution
points: `adapters` · `renderers` · `panels` · `themes` · `locales` · `keymaps` ·
`harnessForms` · `commands`.

- **`@terminull/plugin-api`** (public npm package) — manifest zod schemas, the
  semver gate (`PLUGIN_API_VERSION`), and the real validator
  `validatePluginDir()` at `@terminull/plugin-api/validate` (manifest discovery
  → schema → semver → module jail → duplicate-id). This is the machine oracle.
- **`terminull plugins validate <dir>`** — wraps the validator, printing issues
  with `at` paths (exit 1 on errors, `--json` for machines).
- **`terminull plugins scaffold <point> <name>`** — writes a template; theme ·
  panel · locale are first-class and pass `validate` the moment they are
  written.
- Authoring docs: `docs/plugin-authoring/SKILL.md` (Claude agents) ·
  `docs/plugin-authoring/AGENTS.md` (Codex/Gemini), root `llms.txt` (one-page
  summary), and `examples/` with 3 example plugins (theme · panel · ja locale).
  First-line guardrail: **"Never modify core — extend only via the 8
  contribution points, and after every edit loop `terminull plugins validate`
  until it is green."**

## Supported-tools matrix (tier honesty)

| Tool | Tier | Detect | Drive (PTY) | Transcript render | Harness inject |
| --- | --- | --- | --- | --- | --- |
| **Claude Code** | deep | ✅ PID registry | ✅ keymap/quirks | ✅ native parse | ✅ 7 hooks |
| **Codex** | deep | ✅ rollout | ✅ `exec --json` | ✅ rollout parser | ✅ notify line |
| **agy (Antigravity)** | summary | ✅ | ✅ | 🟡 summary cards (step-level not promised for v1) | ❌ none (no hooks) |
| **ACP agents** | generic | protocol | 🟡 | generic | ❌ (scaffold stage) |
| **Any CLI** | generic PTY | manual | ✅ raw PTY | raw terminal | ❌ |

"Deep" = native transcript parsing plus driving and hook injection; "generic" =
PTY passthrough for any CLI. The honest per-feature gap detail lives in
[docs/parity/gap-matrix.md](./docs/parity/gap-matrix.md).

## Roadmap (v1.1 backlog)

- **OpenCode deep adapter** — native support beyond the generic tier.
- **Plugin store UI** — browse/install plugins from inside the panel.
- **Windows support** — service management is darwin-only (launchd) today;
  linux/windows are honest `unsupported` stubs.
- **Signed builds** — desktop shell packaging + code signing (v0.x ships a
  documented unsigned local build).

---

## Develop

```sh
corepack enable
pnpm install
pnpm -r build
pnpm -r test
pnpm lint
pnpm typecheck
```

## Security

See [SECURITY.md](./SECURITY.md) for the threat model, network posture, secrets
handling, and reporting channel. In short: the server binds 127.0.0.1 (loopback)
by default, injection is consent-shaped and reversible via the provenance
ledger, and **the panel is an audit/governance layer, not a sandbox** — agents
still run with your user privileges.

## Release

The publish sequence and rollback live in
[docs/release-checklist.md](./docs/release-checklist.md). Change history is in
[CHANGELOG.md](./CHANGELOG.md).

## License

[MIT](./LICENSE) © 2026 Rayul
