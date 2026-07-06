# Codex CLI — feature-parity survey

Surveyed: 2026-07-06. Sandbox install `@openai/codex@latest` → **codex-cli 0.142.5**
(native binary in `@openai/codex-darwin-arm64`, 246 MB); user's installed CLI →
**0.142.5**. **Version delta: none.**

How observed: `help` = sandbox `--help` trees with `CODEX_HOME=~/.terminull-sandbox/home-codex`;
`flags` = `codex features list` in the sandbox home; `docs` = official docs sweep
(developers.openai.com/codex/* — the GitHub `docs/*.md` files are now stubs pointing there);
`real` = READ-ONLY structural scan of the user's `~/.codex/sessions` (50 recent rollout
files of 239; type/name fields only).

---

## 1. CLI surface (`help`)

`codex [OPTIONS] [PROMPT]` or `codex <COMMAND>`. Subcommands: `exec (e)`, `review`,
`login`, `logout`, `mcp`, `plugin`, `mcp-server` (run Codex AS an MCP server), `app-server`
(experimental), `remote-control` (experimental daemon manager), `app` (desktop app
launcher), `completion`, `update`, `doctor`, `sandbox` (run arbitrary commands inside the
Codex sandbox), `debug`, `apply (a)` (apply last agent diff), `resume`, `archive`,
`delete`, `unarchive`, `fork`, `cloud` (experimental Codex Cloud task browser),
`exec-server` (experimental), `features`.

Key top-level flags: `-c key=value` (TOML-typed config override), `--enable/--disable
<FEATURE>`, `--remote ws://…|unix://…` + `--remote-auth-token-env` (TUI against a remote
app-server), `--strict-config`, `-i/--image`, `-m/--model`, `--oss` +
`--local-provider lmstudio|ollama`, `-p/--profile` (layered `<name>.config.toml`),
`-s/--sandbox read-only|workspace-write|danger-full-access`,
`--dangerously-bypass-approvals-and-sandbox`, **`--dangerously-bypass-hook-trust`**,
`-C/--cd`, `--add-dir`, `-a/--ask-for-approval untrusted|on-failure|on-request|never`,
`--search`, `--no-alt-screen`.

`codex exec` (headless): `--json` (JSONL events), `-o/--output-last-message <path>`,
`--ephemeral`, `--output-schema <path>`, `--ignore-user-config`, `--ignore-rules`,
`--skip-git-repo-check`, `exec resume [--last | <SESSION_ID>]`.

## 2. Feature flags (`flags` — the definitive systems inventory)

`codex features list` output distinguishes stable/experimental/under-development/removed.
Stable+enabled in 0.142.5: `apps auto_compaction browser_use browser_use_external
browser_use_full_cdp_access computer_use enable_request_compression fast_mode goals
guardian_approval hooks image_generation in_app_browser mentions_v2 multi_agent
personality plugin_sharing plugins remote_compaction_v2 shell_snapshot shell_tool
skill_mcp_dependency_install tool_call_mcp_elicitation`. Stable but default-off:
`secret_auth_storage`. Experimental: `memories network_proxy prevent_idle_sleep`.
Under development (visible roadmap): `artifact chronicle code_mode multi_agent_v2
realtime_conversation rollout_budget sleep_tool standalone_web_search token_budget
terminal_visualization_instructions`.

Adapter implication: `codex features list --json`-style probing (flag inventory) should be
part of the M7 probe so capability claims track the installed binary, exactly like the
claude adapter parses `--help` for permission modes.

## 3. config.toml (`docs` — developers.openai.com/codex/config-reference)

Top-level: `model review_model model_provider openai_base_url model_context_window
model_auto_compact_token_limit model_catalog_json oss_provider approval_policy
approvals_reviewer allow_login_shell sandbox_mode check_for_update_on_startup
developer_instructions model_instructions_file compact_prompt commit_attribution
personality service_tier hide_agent_reasoning show_raw_agent_reasoning disable_paste_burst
chatgpt_base_url cli_auth_credentials_store mcp_oauth_credentials_store web_search
default_permissions forced_login_method forced_chatgpt_workspace_id log_dir sqlite_home
model_reasoning_effort(minimal|low|medium|high|xhigh) plan_mode_reasoning_effort
model_reasoning_summary model_verbosity project_root_markers project_doc_max_bytes(32KiB)
project_doc_fallback_filenames tool_output_token_limit background_terminal_max_timeout
file_opener`.

Tables: `sandbox_workspace_write{writable_roots,network_access,exclude_tmpdir_env_var,
exclude_slash_tmp}`, `windows{sandbox,sandbox_private_desktop}`, `notify` (command array on
notification events), `skills.config[]{path,enabled}`, `apps.<id>.*` (per-app tool approval
modes), `tool_suggest`, `features.*` (§2), `model_providers.<id>.*` (custom providers incl.
`wire_api`, auth command, Bedrock), `shell_environment_policy{inherit,exclude,include_only,
set}`, `projects.<path>.trust_level`, `history{persistence,max_bytes}`,
`hooks.<Event>[]` (§4), `otel.*`, `tui{notifications,animations,alternate_screen,
vim_mode_default,raw_output_mode,status_line,terminal_title,theme,keymap.*,…}`,
`tools{web_search,view_image}`, `mcp_servers.<id>.*` (stdio + url/bearer + per-tool
approval), `agents{max_threads,max_depth,job_max_runtime_seconds,<name>{description,
config_file,nickname_candidates}}` (**named subagent definitions**), `memories.*`,
`permissions.<name>.*` (named permission profiles: filesystem globs, network domain
allow/deny, proxies), `plugins.<plugin>.mcp_servers.*`, `notice.*`,
`approval_policy.granular.*`. Admin layer: `requirements.toml` (`allow_managed_hooks_only`,
`allowed_approval_policies`, `allowed_sandbox_modes`, managed permissions/MCP/plugins).

## 4. Hooks (`docs` — developers.openai.com/codex/hooks; flag `hooks`=stable)

Events: `SessionStart PreToolUse PermissionRequest PostToolUse UserPromptSubmit PreCompact
PostCompact SubagentStart SubagentStop Stop`. Config:

```toml
[[hooks.PreToolUse]]
matcher = "^Bash$"
  [[hooks.PreToolUse.hooks]]
  type = "command"          # only "command" today
  command = '…'
  command_windows = '…'
  timeout = 30
  statusMessage = "…"
```

**Trust model (critical for the M7 injector)**: non-managed hooks must be approved in the
TUI via `/hooks`; trust binds to a **hash of the hook script** — any edit invalidates it
and the hook is silently skipped until re-approved. Plugins do NOT auto-trust their hooks.
Managed hooks (MDM/`requirements.toml`) bypass user trust. `--dangerously-bypass-hook-trust`
is the only non-interactive escape. ⇒ Terminull cannot silently install working Codex
hooks the way the Claude injector does; the injector must (a) write config, (b) walk the
user through `/hooks` approval or document the bypass flag, and (c) re-trigger approval on
every hook-script update. Also `agy` 1.0.16 notes an empty-decision crash fix — return
explicit decisions from PreToolUse hooks.

## 5. TUI slash commands (`docs` — cli/slash-commands)

`/permissions /ide /keymap /vim /sandbox-add-read-dir(Win) /agent /apps /plugins /hooks
/clear /archive /delete /compact /copy /diff /exit /experimental /approve /memories /skills
/import /feedback /init /logout /mcp /mention /model /fast /plan /goal /personality /ps
/stop /fork /side(/btw) /raw /resume /new /quit /review /status /usage /debug-config
/statusline /title /theme` (~45). `/import` migrates a Claude Code setup. `/goal` singular.

## 6. Harness files (`docs`)

- **AGENTS.md**: global `$CODEX_HOME/AGENTS.override.md`→`AGENTS.md`; project = repo root
  → cwd, per dir `AGENTS.override.md` → `AGENTS.md` → `project_doc_fallback_filenames`;
  concatenated root→leaf, capped at `project_doc_max_bytes` (32 KiB default), one file per
  dir. Follows the agents.md convention.
- **Skills**: dir with `SKILL.md` (name/description frontmatter) + optional `scripts/
  references/ assets/ agents/openai.yaml` (UI metadata, `policy.allow_implicit_invocation`,
  `dependencies`). Discovery: repo `.agents/skills` → `~/.agents/skills` →
  `/etc/codex/skills` → built-in. Skill-list context capped ~2%/8,000 chars.
- **Plugins**: bundle of skills + app/MCP config; `codex plugin` CLI verb exists (`help`)
  alongside TUI `/plugins`; config `plugins.<plugin>.mcp_servers.*`.
- **Profiles**: `$CODEX_HOME/<name>.config.toml` layered via `-p`.

## 7. Session/rollout record kinds (`real`)

Path: `~/.codex/sessions/YYYY/MM/DD/rollout-<TIMESTAMP>-<UUID>.jsonl`; resume appends.
RolloutLine `type` values observed: `session_meta response_item event_msg turn_context
compacted`.

`response_item` payload types: `function_call function_call_output message reasoning
web_search_call custom_tool_call custom_tool_call_output tool_search_call
tool_search_output` (+ docs: `local_shell_call`? not observed). `event_msg` payload types:
`token_count agent_message user_message task_started task_complete mcp_tool_call_end
exec_command_end web_search_end patch_apply_end agent_reasoning turn_aborted
dynamic_tool_call_request dynamic_tool_call_response context_compacted
thread_name_updated`. `session_meta` payload keys: `id timestamp cwd cli_version
originator source thread_source model_provider base_instructions dynamic_tools git`.

Tool (`function_call.name`) values observed: `exec_command write_stdin spawn_agent
close_agent wait_agent click get_app_state update_plan view_image js
automation_update load_workspace_dependencies list_apps` + MCP-app tools
(`_get_file_metadata _list_folder _search _recent_documents _list_drives _get_profile`).
`spawn_agent/wait_agent/close_agent` = multi_agent; `click/get_app_state/js` =
browser/computer use; `write_stdin` = interactive exec sessions.

`codex exec --json` event types (`docs`): `thread.started turn.started turn.completed
turn.failed item.started item.completed error`.

## 8. Feature systems (one-line surface each)

- **Cloud** (`codex cloud`, experimental): browse hosted tasks, apply diffs locally.
- **App-server / remote control**: `codex app-server`, `codex remote-control` daemon; TUI
  attaches via `--remote ws://…`; SSH-based "remote projects" in the desktop app.
- **Apps/connectors**: `apps.*` config + `/apps`; ChatGPT-app tools with per-tool approval.
- **Automations**: scheduled tasks defined conversationally (`automation_update` tool
  observed in real rollouts), run in app/cloud.
- **Sandboxing**: OS-level (`codex sandbox` to test), 3 modes + granular
  `permissions.<name>` profiles + network proxy feature.
- **Review**: `codex review` non-interactive + `/review` + `review_model` +
  `approvals_reviewer auto_review` policy file.
- **Memories** (experimental): rollout-mined memories, consolidation models configurable.
- **MCP**: client (`codex mcp add/list`, rich per-tool approval) and server (`codex
  mcp-server`).

## 9. Enumeration gaps (honest)

- TUI-only behaviour (slash command availability, hooks trust flow, personality) not
  exercised live — sandbox had no auth; sourced from official docs.
- Rollout payload FIELD schemas beyond type/name (e.g. `function_call_output` shape) not
  tabulated — fixtures should capture full golden lines (fields are visible in the real
  files; deferred to fixture capture to keep this scan structural).
- `codex app-server` JSON-RPC protocol not enumerated (needs a running daemon; it is the
  likely best co-drive channel for M7 — investigate before committing to PTY-only).
- Known upstream bugs to design around: unbounded rollout growth from repeated compaction
  (openai/codex#24948), 0644 world-readable rollouts (#21660).
