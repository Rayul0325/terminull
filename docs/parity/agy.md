# agy (Google Antigravity CLI) — feature-parity survey

Surveyed: 2026-07-06. Installed binary: **1.0.16** (`/Users/obogyo/.local/bin/agy`).
Latest per the CLI's own changelog (`agy changelog`, top entry = 1.0.16) and the official
`google-antigravity/antigravity-cli` CHANGELOG: **1.0.16 — no version delta.** No sandboxed
reinstall was performed (no npm distribution; the installed binary + read-only home
inspection were used instead, which is honest but means "fresh default home" behaviour was
not observed).

How observed: `help` = `agy --help`, `agy plugin --help`; `cmd` = `agy models`,
`agy changelog`; `real` = READ-ONLY listing of `~/.gemini` + sqlite `.schema`/enum queries
(structure only); `docs` = official GitHub CHANGELOG (primary) + secondary sources — the
antigravity.google docs site is a JS-rendered SPA that returns an empty shell to fetchers,
so several details below are flagged UNVERIFIED.

---

## 1. CLI surface (`help`)

Flags: `--add-dir` (repeatable), `-c/--continue`, `--conversation <id>` (resume by ID),
`--dangerously-skip-permissions`, `-i/--prompt-interactive`, `--log-file`, `--model`,
`--new-project`, `-p/--print` (+ `--prompt` alias, `--print-timeout` default 5m),
`--project <id>`, `--sandbox` (terminal restrictions).

Subcommands: `changelog`, `help`, `install` (env paths/shell settings), `models`,
`plugin|plugins`, `update`.

`agy plugin`: `list`, **`import [source]` — imports plugins "from gemini or claude"**
(direct Claude-Code-harness migration path), `install <target>` (supports
`plugin@marketplace`), `uninstall`, `enable`, `disable`, `validate [path]`,
`link <mp> <target>` (marketplace link).

Print mode emits plain text only — no JSON envelope flag (UNVERIFIED against primary docs,
consistent with observed `--help`); a Terminull co-drive channel would be PTY or
`--print` text.

## 2. Models (`cmd`)

`agy models` (works unauthenticated): `Gemini 3.5 Flash (Medium|High|Low)`,
`Gemini 3.1 Pro (Low|High)`, `Claude Sonnet 4.6 (Thinking)`, `Claude Opus 4.6 (Thinking)`,
`GPT-OSS 120B (Medium)`. Model discovery for the adapter can therefore be `dynamic` via
this command (parse, don't hardcode).

## 3. Config home layout (`real` — observed tree)

```
~/.gemini/
  GEMINI.md  settings.json  projects.json  history/  skills/
  google_accounts.json  oauth_creds.json  …            # credentials — NEVER read
  config/
    config.json  mcp_config.json  plugins/  projects/  sidecars/  skills/
  antigravity-cli/
    settings.json  keybindings.json  history.jsonl  cli.log  log/
    conversations/<uuid>.db (+ -wal/-shm)              # per-conversation sqlite
    conversation_summaries.db                          # cross-conversation index
    cache/  brain/  knowledge/  builtin/  implicit/  scratch/  bin/  updater/
    jetski_state.pbtxt  installation_id  last_check.timestamp
  antigravity/  antigravity-ide/                       # IDE-track siblings
```

Hooks config: `~/.gemini/config/hooks.json` (secondary-sourced; the dir exists, the file
was not present on this machine). Project configs at `~/.gemini/config/projects/` override
global (CHANGELOG 1.0.12). Keybindings: `~/.gemini/antigravity-cli/keybindings.json`
(entries like `"cli.clear_screen": ["ctrl+l"]`; `cli.exit`/`cli.enter` protected).

## 4. Harness md files

`.antigravity.md` (recommended) or `GEMINI.md` (back-compat) + `AGENTS.md` in the project,
plus `.agent/rules/` and nested `AGENTS.md`; `.antigravity.md` wins over `GEMINI.md`.
Global: `~/.gemini/GEMINI.md` (observed) and `~/.gemini/AGENTS.md`. (Precedence details
secondary-sourced — verify empirically before the M7 adapter hardcodes them.)

## 5. Conversation storage (`real` — sqlite, structure only)

Per-conversation DB `conversations/<uuid>.db`:

- `trajectory_meta(trajectory_id, cascade_id, trajectory_type, source)` — observed
  `trajectory_type=4, source=17`.
- `steps(idx, step_type INT, status INT, has_subtrajectory, metadata BLOB,
  error_details BLOB, permissions BLOB, task_details BLOB, render_info BLOB,
  step_payload BLOB, step_format INT)` — **step content is opaque blobs (protobuf-like;
  `step_format=0` observed); `step_type` is an integer enum.** Distinct values observed
  across 8 recent DBs: `7 8 9 14 15 21 23 31 33 98 101 132`.
- `gen_metadata / executor_metadata / parent_references / battle_mode_infos /
  trajectory_metadata_blob` — all `(idx, data BLOB)` shaped.

Cross-conversation index `conversation_summaries.db` →
`conversation_summaries(conversation_id, title, preview, step_count, last_modified_time,
workspace_uris, status, source, project_id, agent_name, parent_conversation_id,
nesting_depth, battle_id, winning_conversation_id, not_fully_idle, killed,
last_user_input_time, last_user_input_step_index, app_data_dir)`.

Adapter implication (load-bearing): a session **collector** is cheap and safe —
`conversation_summaries.db` has title/preview/status/mtime/workspace, everything a session
list needs, without touching blobs. A full transcript **parser** requires reverse-
engineering the step_type enum + blob encoding (or an official export surface) — high
effort, version-fragile. Recommend: M7 ships collector + summary-level rendering; deep
step rendering is a separate spike with its own go/no-go.

## 6. Feature systems (CHANGELOG-sourced, primary)

- **Subagents + background tasks**: live status indicator (1.0.15), dynamic subagent
  definitions in Markdown (1.0.16), `/tasks` detail panel with streaming logs (1.0.16),
  "always proceeds" auto-approval for subagent artifacts (1.0.14).
- **Goals**: `/goal` uncapped (1.0.14).
- **Permissions**: `/permissions` panel with dynamic disk reload (1.0.15); stricter command
  matching + optional regex (1.0.13); pre-tool hooks where an empty decision string used to
  crash (fixed 1.0.16) and a failing hook = deny (secondary).
- **Artifacts**: artifact view with `$EDITOR` handoff (`ctrl+g`, 1.0.15), comments.
- **Projects**: `--project/--new-project` (1.0.12), workspace↔project cache
  `antigravity-cli/cache/projects.json`.
- **MCP**: `~/.gemini/config/mcp_config.json` shared with the IDE; url-based remote
  servers; 60s connect timeout (1.0.15).
- **Battle mode**: `battle_mode_infos` table + `battle_id/winning_conversation_id` columns
  — parallel candidate conversations with a winner (no public docs found).

## 7. Enumeration gaps (honest)

- Official docs SPA unreadable to fetchers ⇒ settings.json key inventory, full hook event
  list, and md-file precedence are secondary-sourced or UNVERIFIED. Close by: running
  `agy` TUI live (`/config`, `/permissions`, `/hooks`?) in a throwaway HOME, and/or
  `strings` over the Go binary for event names (not done in this pass).
- step_type integer→meaning mapping unknown; needs a controlled experiment (drive one
  small conversation, diff the steps table against the known actions).
- IDE-track version numbers (e.g. "v1.20.3 AGENTS.md support") do not map to CLI 1.0.x —
  do not mix the tracks when citing versions.
- No fresh-home run: first-run scaffolding (which files agy creates) unobserved.
