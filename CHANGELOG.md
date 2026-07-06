# Changelog

All notable changes to Terminull. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] — 2026-07-06

Patch release for `terminull` (CLI) only — `terminull-plugin-api` stays 0.1.0.

### Fixed

- `terminull serve` now actually hosts the web UI: the server gained built-in
  static UI hosting (SPA fallback, path-traversal jail, smoke page demoted to
  an honest fallback) and the CLI resolves the UI directory in both dev and
  installed-tarball layouts. In 0.1.0, `npx terminull serve` returned an
  M5-era placeholder (or a 500) instead of the panel. The pack-smoke CI job
  now asserts "real UI from the installed tarball" on every push.
- Claude transcript path encoding: every non-alphanumeric character of the
  session cwd is dash-encoded (matching Claude Code's real project-dir rule),
  fixing 502s for sessions whose cwd contains dots, spaces, or non-ASCII;
  unresolvable transcripts degrade to an honest `supported: false`.

### Added

- `terminull migrate --from control-tower` (M11): dry-run by default;
  `--execute` removes legacy hooks with user hooks byte-preserved + backup,
  restores codex notify, archives the legacy LaunchAgent/state with a sha
  manifest, prints an exact rollback block, and is idempotent.

## [0.1.0] — 2026-07-06

First public release. Two packages are published to npm — `terminull` (the CLI
product entry) and `terminull-plugin-api` (plugin-authoring types + validator);
all other workspace packages stay private. Built across milestones M0–M10.

### Added

- **Foundation (M0–M2)** — pnpm + TypeScript monorepo (Node 22, strict
  NodeNext), CI (build/test/lint/typecheck on macOS + Linux), i18n lint gate;
  core event store, secret masking, agent permissions; `paneld` PTY session-host
  daemon (PTY ownership, wire protocol, tmux adopt).
- **Adapter platform (M3)** — adapter SDK, plugin runtime v1, generic PTY
  adapter (dogfooded).
- **Deep adapters (M4, M7)** — Claude Code (collector, transcript parser,
  PTY driver, harness injector, statusline schema); Codex (rollout parser,
  `exec --json` driver, token usage, notify injector); agy/Antigravity
  (summary-level, honest opaque-transcript posture).
- **Panel server (M5)** — HTTP + WebSocket API, auth gate (loopback trust,
  bearer/cookie, Origin/CSWSH defense), `paneld` client, `server.json`
  discovery, smoke fleet page.
- **Web panel v1 (M6)** — dockview workspace, per-tool renderer registry,
  zustand stores, live terminal, ko/en i18n (react-i18next).
- **Agent management (M7)** — supervisor brain (stream-json, injection fencing,
  caps), agent wire protocol (proposed actions, approval cards), server agent
  routes + approval-chain audit, web permission toggles / approval inbox
  (masked params) / tool-usage gauge.
- **Multi-machine (M8)** — machine protocol (registry FSM, transport spec,
  machine-tagged session DTOs), session-host agent mode (SSH stdio relay,
  AF_UNIX socket-path guard), server machine registry + two-machine relay
  oracle, CLI `enroll` / `enroll --remove` / `machines status` over an SSH
  runner seam (idempotent install, full reversal), web machine badges +
  staleness chips.
- **Harness editing (M9)** — `HarnessFileEngine` (path jail, parse validation,
  sha optimistic lock, backup rotation, atomic write, content-free audit),
  harness/profile wire protocol, adapter config-home isolation, web harness
  editor (diff / 409 / 422 / backup-restore), account center, session-create
  stepper, keybinding editor, mobile shell.
- **Install + publish (M10, this release)**
  - `terminull-plugin-api` — public plugin contract: `PLUGIN_API_VERSION`
    semver gate, `LocalizedText`, 8 contribution points, zod manifest schemas,
    and the node-only `validatePluginDir()` validator (manifest discovery,
    schema, semver gate, module jail, duplicate-id check).
  - Consent-shaped injection engine (`@terminull/core`) — JSON append-dedup,
    TOML single-line surgical patch (never reserializes; `[projects.*]` trust
    tables survive byte-identical), provenance ledger `injected.json` (exact
    bytes, sha before/after, backup path), drift-respecting eject.
  - CLI product surface — `setup` (detect → diff preview → per-tool consent →
    inject → service → healthcheck → panel URL), `inject` / `eject`, `doctor`,
    `uninstall`, `plugins validate` / `scaffold`, darwin launchd service
    manager, tsup single-bundle publish packaging.
  - Plugin authoring kit — scaffold templates (theme/panel/locale first-class),
    3 example plugins (obsidian-warm theme, scratchpad panel, ja locale),
    `SKILL.md` + `AGENTS.md` authoring docs, root `llms.txt`.
  - Electron thin-shell skeleton — single-instance, sandboxed, deny-all
    popouts, `server.json` discovery mirror (attach + managed modes;
    packaging/signing deferred).
  - Docs + release prep — trust-first README (ko/en), `SECURITY.md`
    (governance-layer-not-sandbox threat model), release checklist, CI
    pack-smoke job.

### Security

- Server binds `127.0.0.1:7420` by default; wildcard bind refused without
  `--unsafe-bind` (prints a threat warning otherwise).
- Injection never reads credential bodies (`auth.json`, `.credentials.json`,
  token files) — existence only.
- Secret masking (best-effort) over free text; state/discovery files written
  `0600`.
- Documented honestly: the panel is an audit/governance layer, not a sandbox —
  agents run with user privileges (see `SECURITY.md`).

### Notes

- Service management is darwin-only (launchd); linux/windows are honest
  `unsupported` stubs.
- Desktop shell ships as an unsigned local build (no electron-builder yet).
- v1.1 backlog: OpenCode deep adapter, plugin store UI, Windows support, signed
  builds.

[0.1.0]: https://github.com/rayul/terminull/releases/tag/v0.1.0
