# Claude Code — feature-parity survey

Surveyed: 2026-07-06. Sandbox install `@anthropic-ai/claude-code@latest` → **2.1.201**;
user's installed CLI → **2.1.201**. **Version delta: none.** agy/codex surveyed separately.

How observed (evidence classes used below):
- `help` — sandbox binary `--help` trees with `CLAUDE_CONFIG_DIR=~/.terminull-sandbox/home-claude` (never the real home).
- `bin` — `strings` over the native binary (`node_modules/@anthropic-ai/claude-code/bin/claude.exe`, 231 MB Bun build).
- `sdk` — `node_modules/@anthropic-ai/claude-code/sdk-tools.d.ts` (official tool I/O types, 3,515 lines).
- `docs` — official docs sweep (code.claude.com/docs, canonical host after docs.anthropic.com 301s).
- `real` — READ-ONLY structural scan of the user's `~/.claude` (keys/type names only, never content): 400 most-recent transcript `.jsonl` files (of 5,864), settings.json key names, dir listings.

---

## 1. CLI surface (`help`)

Top-level: `claude [options] [command] [prompt]`. Subcommands: `agents` (background agent
manager), `auth`, `auto-mode`, `doctor`, `gateway` (enterprise auth/telemetry), `install`,
`mcp`, `plugin|plugins`, `project`, `setup-token`, `ultrareview`, `update|upgrade`.

Flags that define adapter-relevant behaviour (full capture in the survey scratchpad; the
load-bearing ones):

| Flag | Adapter implication |
|---|---|
| `-p/--print`, `--output-format text\|json\|stream-json`, `--input-format stream-json` | headless co-drive channel (already declared `headless:'stream-json'`) |
| `--include-hook-events`, `--include-partial-messages`, `--replay-user-messages` | stream-json enrichment M7-codex has no equivalent of |
| `--bg/--background`, `claude agents` | background-agent system (supervisor daemon, `~/.claude/jobs/<id>/`, `~/.claude/daemon.log`) |
| `--remote-control [name]`, `--remote-control-session-name-prefix` | remote-control session mode |
| `-r/--resume [search]`, `--fork-session`, `--from-pr`, `--session-id`, `-c/--continue`, `-n/--name` | session lifecycle verbs a GUI should expose |
| `--permission-mode` choices: `acceptEdits, auto, bypassPermissions, manual, dontAsk, plan` | **`auto` + `manual` are new vs the adapter's builtin fallback list** (probe already parses help — good) |
| `--effort low\|medium\|high\|xhigh\|max` | effort is a first-class session dial |
| `--model` aliases `fable/opus/sonnet` | **adapter `models.ts` fallback aliases lack `fable`** |
| `-w/--worktree [name]`, `--tmux[=classic]` | worktree-per-session + tmux integration |
| `--agents <json>`, `--agent <agent>` | session-scoped custom agents |
| `--settings`, `--setting-sources user,project,local`, `--mcp-config`, `--strict-mcp-config`, `--plugin-dir`, `--plugin-url` | config layering knobs |
| `--safe-mode`, `--bare` | customization-free boot modes (useful for Terminull probes) |
| `--json-schema`, `--max-budget-usd`, `--fallback-model`, `--no-session-persistence`, `--prompt-suggestions` | headless/SDK extras |
| `--ax-screen-reader`, `--chrome/--no-chrome`, `--ide`, `--brief`, `--betas`, `--file` | niche surfaces, low parity priority |

## 2. Slash commands

Built-ins extracted from the binary (`bin`, pattern `type:"local|local-jsx|prompt",name:"…"`,
108 registrations ≈ 100 unique names):

- **Session/flow**: `clear compact context resume fork session rename exit help status version copy export diff branch cd add-dir`
- **Config/UI**: `config theme color scroll-speed terminal-setup tui statusline keybindings privacy-settings`
- **Model/effort**: `model effort fast passes powerup wellbeing` (`passes`/`powerup` undocumented)
- **Permissions/hooks**: `permissions hooks allowed-tools(via permissions) plan`
- **Harness**: `memory pause-memory skills skill-doctor reload-skills reload-plugins plugin mcp agents`
- **Systems**: `goal loops workflows tasks background daemon stop recap btw focus brief advisor`
- **Accounts/billing**: `login logout upgrade usage usage-credits extra-usage rate-limit-options pro-trial-expired stickers`
- **Integrations**: `ide desktop mobile install install-github-app install-slack-app web-setup remote-control remote-env teleport setup-bedrock setup-vertex design design-consent design-login design-revoke chrome(settings) radio voice heapdump`
- **Cloud review/plan**: `ultrareview ultraplan autofix-pr`
- **Prompt-type built-ins** (`type:"prompt"`): `init insights review team-onboarding`
- **Bundled Skills** shipping as commands (`docs` + live session observation): `code-review security-review simplify verify loop schedule batch debug claude-api run fewer-permission-prompts dataviz artifact-design update-config keybindings-help init review deep-research(Workflow)`
- **Extension points**: user/project commands (`~/.claude/commands`, `.claude/commands` — now unified with skills), plugin commands (`plugin:name`), MCP prompts as `/mcp__server__prompt`.

Adapter implication: `slashCommands:'discoverable'` is honest for user commands; the
built-in list above should become a static catalog in the adapter (source-tagged
`builtin-maybe-stale`, same pattern as permission modes) so the GUI can offer a palette.

## 3. Hooks (events `bin`+`docs`, payloads `docs`, usage `real`)

30 documented events (18 independently confirmed as strings in the binary). Common input:
`session_id, transcript_path, cwd, hook_event_name`; common output: `systemMessage,
suppressOutput, continue, stopReason`; exit 0=JSON processed, 2=blocking, else non-blocking.
Hook types: `command, http, mcp_tool, prompt, agent`.

| Event | Matcher | Key payload / output |
|---|---|---|
| SessionStart | startup/resume/clear/compact | out: `additionalContext, initialUserMessage, sessionTitle, watchPaths, reloadSkills` |
| Setup | init/maintenance | `CLAUDE_ENV_FILE` |
| UserPromptSubmit | — | `prompt`; exit2 blocks+erases; `decision:"block"`, `additionalContext` |
| UserPromptExpansion | command name | `command_name, expanded_prompt` |
| PreToolUse | tool name | `tool_name, tool_input`; out `permissionDecision allow/deny/ask/defer`, `updatedInput` |
| PermissionRequest | tool name | out `decision:{behavior,updatedInput}` |
| PermissionDenied | tool name | out `retry:true` |
| PostToolUse | tool name | `tool_result`; out `updatedToolOutput`, `additionalContext` |
| PostToolUseFailure | tool name | `error` |
| PostToolBatch | — | `tool_results[]` |
| Stop | — | `response`; exit2 prevents stop |
| StopFailure | error type | `error_type, error_message` (logging only) |
| SubagentStart / SubagentStop | agent type | `agent_type, agent_id` |
| TaskCreated / TaskCompleted | — | `task_name, …`; exit2 rolls back / prevents completion |
| TeammateIdle | — | exit2 keeps teammate working |
| Notification | notification type | `notification_type, message` |
| MessageDisplay | — | out `displayContent` |
| CwdChanged / FileChanged / ConfigChange / InstructionsLoaded | varies | env/file/config observability |
| PreCompact / PostCompact | manual/auto / — | exit2 blocks compaction / logging |
| WorktreeCreate / WorktreeRemove | — | stdout=worktree path / cleanup |
| Elicitation / ElicitationResult | MCP server | MCP elicitation interception |
| SessionEnd | end reason | cleanup only |

Terminull's injector today registers 7 hooks on 7 events (`injector.ts`): SessionStart,
UserPromptSubmit, PreToolUse(AskUserQuestion), PostToolUse(ExitPlanMode), Notification,
Stop, SessionEnd. The user's real settings.json additionally uses SubagentStart,
TaskCompleted, PreCompact — proof those fire in practice.

## 4. Settings (`docs` full inventory; `real` = keys seen in the user's file)

Scopes (high→low): managed-settings.json → CLI args → `.claude/settings.local.json` →
`.claude/settings.json` → `~/.claude/settings.json`. Key groups (names verbatim, see docs
for one-liners):

- Model: `model advisorModel fallbackModel availableModels enforceAvailableModels modelOverrides alwaysThinkingEnabled effortLevel`
- Permissions: `permissions{allow,ask,deny,additionalDirectories,defaultMode,disableBypassPermissionsMode} allowManagedPermissionRulesOnly autoMode`
- UI: `outputStyle tui axScreenReader prefersReducedMotion autoScrollEnabled spinnerTipsEnabled awaySummaryEnabled viewMode editorMode language theme preferredNotifChannel autoCompactEnabled askUserQuestionTimeout leftArrowOpensAgents`
- Memory/files: `autoMemoryEnabled autoMemoryDirectory claudeMd claudeMdExcludes fileCheckpointingEnabled cleanupPeriodDays plansDirectory`
- Auth/integrations: `agent env apiKeyHelper awsAuthRefresh awsCredentialExport gcpAuthRefresh otelHeadersHelper forceLoginMethod forceLoginOrgUUID forceLoginGatewayUrl`
- Hooks: `hooks allowedHttpHookUrls httpHookAllowedEnvVars allowManagedHooksOnly disableAllHooks`
- MCP: `allowedMcpServers deniedMcpServers allowManagedMcpServersOnly disabledMcpjsonServers enabledMcpjsonServers enableAllProjectMcpServers disableClaudeAiConnectors allowAllClaudeAiMcps`
- Plugins/skills: `enabledPlugins extraKnownMarketplaces blockedMarketplaces pluginSuggestionMarketplaces strictKnownMarketplaces disableBundledSkills disableSkillShellExecution disableWorkflows skillOverrides skillListingBudgetFraction skillListingMaxDescChars subagentStatusLine`
- Status line: `statusLine{type:"command",command,padding,refreshInterval,hideVimModeIndicator}`
- Remote/notif: `disableRemoteControl agentPushNotifEnabled inputNeededNotifEnabled messageIdleNotifThresholdMs`
- Git/artifact: `attribution includeCoAuthoredBy includeGitInstructions prUrlTemplate enableArtifact disableArtifact`
- Updates/admin: `autoUpdatesChannel minimumVersion requiredMinimumVersion requiredMaximumVersion companyAnnouncements policyHelper parentSettingsBehavior defaultShell worktree.bgIsolation disableAutoMode disableAgentView disableSideloadFlags disableDeepLinkRegistration channelsEnabled feedbackSurveyRate fastModePerSessionOptIn`
- `real`-only keys observed (undocumented or newer): `skipAutoPermissionPrompt skipDangerousModePermissionPrompt`

Also part of the config family: `~/.claude/keybindings.json`, `~/.claude.json` (state +
`oauthAccount`), `.mcp.json` (project MCP), `~/.claude/CLAUDE.md`, `CLAUDE.local.md`,
`~/.claude/memory/` (auto-memory), `~/.claude/plugins/`, `~/.claude/projects/` (transcripts),
`~/.claude/sessions/<PID>.json` (live registry — the collector's source), `~/.claude/jobs/`
(background agents), `~/.claude/plans/`.

## 5. Statusline stdin schema (`docs`, fields corroborated in `bin`)

`cwd, session_id, session_name?, prompt_id?, transcript_path, model{id,display_name},
workspace{current_dir,project_dir,added_dirs,git_worktree?,repo{host,owner,name}?}, version,
output_style.name, cost{total_cost_usd,total_duration_ms,total_api_duration_ms,
total_lines_added,total_lines_removed}, context_window{total_input_tokens,
total_output_tokens,context_window_size,used_percentage,remaining_percentage,
current_usage{input_tokens,output_tokens,cache_creation_input_tokens,cache_read_input_tokens}},
exceeds_200k_tokens, effort.level?, thinking.enabled, rate_limits{five_hour,seven_day}?,
vim.mode?, agent.name?, pr{number,url,review_state}?, worktree{name,path,branch,…}?`

Adapter implication: this is the richest per-session live telemetry channel Claude Code
exposes; a Terminull statusline shim (a `statusLine.command` that tees the JSON to the
panel) would give M6 cost/context/PR data with zero transcript parsing.

## 6. Harness md files & extension formats (`docs`)

- **CLAUDE.md**: `~/.claude/CLAUDE.md` (global) → project root `CLAUDE.md` (+ `CLAUDE.local.md`) → nested per-dir CLAUDE.md loaded on directory traversal; `claudeMd`/`claudeMdExcludes` settings gate it; `--bare` disables discovery.
- **Skills/commands (unified)**: `SKILL.md` frontmatter: `name description when_to_use argument-hint arguments disable-model-invocation user-invocable allowed-tools disallowed-tools model effort context:fork agent hooks paths shell`; substitutions `$ARGUMENTS $N ${CLAUDE_SESSION_ID} ${CLAUDE_SKILL_DIR} ${CLAUDE_PROJECT_DIR}`; dynamic-context inline shell `` !`cmd` ``. Scopes: enterprise > personal (`~/.claude/skills/`) > project (`.claude/skills/`) > plugin.
- **Subagents**: `.claude/agents/*.md` frontmatter: `name description tools disallowedTools model permissionMode maxTurns skills mcpServers hooks memory(user/project/local) background effort isolation:worktree color initialPrompt`. Built-ins: Explore, Plan, general-purpose, statusline-setup, claude-code-guide. Nesting depth limit 5.
- **Plugins**: `.claude-plugin/plugin.json` (required `name`; component paths `skills commands agents hooks mcpServers outputStyles lspServers experimental.themes experimental.monitors userConfig channels dependencies`); dirs `skills/ commands/ agents/ output-styles/ themes/ monitors/ hooks/hooks.json .mcp.json .lsp.json bin/ settings.json`; env `${CLAUDE_PLUGIN_ROOT} ${CLAUDE_PLUGIN_DATA}`; marketplaces `claude-plugins-official`, `claude-community`.

## 7. Transcript record kinds (`real`, structural scan of 400 recent files)

Top-level `type` (+ `system` subtypes), with observed counts:

| type[:subtype] | n | Renderer need |
|---|---|---|
| `assistant` | 24,251 | text / tool_use / thinking blocks |
| `user` | 12,633 | text, command chips, tool_result carrier |
| `attachment` | 8,920 | attachment chip (file/dir context) |
| `last-prompt` | 4,259 | session-meta stream (not chat) |
| `ai-title` | 3,720 | session-meta (title) |
| `mode` | 3,475 | session-meta (mode change event) |
| `permission-mode` | 3,461 | session-meta / event chip |
| `agent-name` | 3,080 | session-meta (named agent) |
| `custom-title` | 3,025 | session-meta |
| `queue-operation` | 2,138 | queued-prompt chip |
| `file-history-snapshot` | 1,333 | checkpoint marker (rewind UI) |
| `system:stop_hook_summary` | 766 | hook-result event chip |
| `system:turn_duration` | 686 | telemetry (optional footer) |
| `system:away_summary` | 259 | summary card |
| `system:api_error` | 94 | error banner |
| `system:compact_boundary` | 60 | compaction divider |
| `system:local_command` | 55 | `!cmd` output chip |
| `bridge-session` | 55 | remote-bridge marker |
| `system:scheduled_task_fire` | 5 | scheduler event |
| `system:bridge_status` | 3 | remote-bridge status |

Envelope keys (union, structural): `uuid parentUuid logicalParentUuid sessionId timestamp
type subtype cwd gitBranch version entrypoint userType requestId isSidechain isMeta
isApiErrorMessage error apiErrorStatus attributionSkill message` (assistant);
user adds `permissionMode promptId promptSource sourceToolUseID sourceToolAssistantUUID
toolUseResult toolDenialKind toolEndsTurn`; system adds `content level hookCount hookInfos
hookErrors hookAdditionalContext preventedContinuation stopReason durationMs compactMetadata
pendingBackgroundAgentCount pendingWorkflowCount retryAttempt maxRetries retryInMs slug url
toolUseID sessionKind messageCount hasOutput`.

Message content block types observed: `tool_use tool_result thinking text image document`.

Tool names observed live (33): `Bash Read Edit Write TaskUpdate Agent Grep StructuredOutput
Skill TaskCreate AskUserQuestion Workflow ToolSearch Glob TaskOutput WebSearch SendMessage
Monitor ExitPlanMode TaskStop TaskList ScheduleWakeup WebFetch EnterPlanMode PushNotification
CronList mcp__<server>__<tool>…`. The official SDK tool set (`sdk`) additionally defines:
`Artifact ClaudeDesign CronCreate CronDelete EnterWorktree ExitWorktree FileRead(=Read)
FileEdit FileWrite ListMcpResources ReadMcpResource ReadMcpResourceDir Mcp NotebookEdit
Projects REPL RemoteTrigger ReportFindings ShowOnboardingRolePicker TaskGet TodoWrite` —
i.e. the M6 registry must cover ~45 named tools + `mcp__*` + a generic fallback.
`StructuredOutput` appears in live transcripts but NOT in sdk-tools.d.ts — treat the union
as the contract, with fallback rendering mandatory.

## 8. Feature systems (one-line surface each)

- **Background agents**: `claude --bg`, `claude agents` view, supervisor daemon, `~/.claude/jobs/<id>/`, auto worktree isolation + auto draft PRs; shell verbs `claude attach/logs/stop/respawn/rm/daemon status`.
- **Agent teams**: named teammates from agent defs, SendMessage/TaskCreate records in transcripts (observed live), `TeammateIdle`/`TaskCompleted` hooks.
- **Workflows / goals / loops**: `/workflows` progress view, `Workflow` tool records (observed), `/goal` = Haiku-judged stop condition, `/loop` interval re-run; `pendingWorkflowCount` on system records.
- **Checkpointing/rewind**: `file-history-snapshot` records + `/rewind`; SDK `rewindFiles()`.
- **Remote control**: `/remote-control`, `--remote-control`, claude.ai/mobile pairing; `bridge-session`/`system:bridge_status` records observed.
- **MCP**: client (`claude mcp add/list/serve`, `.mcp.json`, elicitation hooks) and server (`claude mcp serve`).
- **Plugins**: full component system (see §6) + marketplaces.
- **Sandboxing**: `sandbox` settings key + `--allow-dangerously-skip-permissions` gate; auto-mode classifier (`claude auto-mode`).
- **Cloud**: ultrareview/ultraplan/autofix-pr, `/schedule` routines, `/teleport` (session → cloud handoff), Chrome/desktop/mobile companions.

## 9. Enumeration gaps (honest)

- `/help` inside an authed TUI was not run (no login in sandbox); the built-in command list comes from binary strings + docs — descriptions for undocumented ones (`radio`, `stickers`, `passes`, `powerup`, `btw`, `focus`) are unknown.
- Hook payloads are docs-sourced; only event NAMES were binary-confirmed. Golden payload captures need a live hooked session (fixtures-needed.md).
- Teams/agent-view schemas (`~/.claude/jobs/`, teammate message records) were not deep-scanned; `SendMessage`/`TaskCreate` tool records confirm the surface exists.
- Settings docs list is from the official reference; no JSON schema dump was obtainable from the binary to cross-check completeness.
