# Feature-parity gap matrix — THE implementation contract

Basis: `claude-code.md`, `codex.md`, `agy.md` (same survey, 2026-07-06). Adapter "today"
columns are honest code assessments of `packages/adapters/*/src` at survey time:
claude = 2,178 LOC deep adapter; codex & agy & acp = 9-line stubs; generic = PTY-only.

Legend: ✅ done · 🟡 partial · ❌ missing. Columns: **CL** = claude adapter today,
**CX** = codex adapter today, **AG** = agy adapter today, **M6** = GUI renderer work,
**M7** = codex/agy deep-adapter work, **M4x** = claude-adapter extension backlog.

## A. Session discovery & lifecycle

| Feature                                                      | CL                                                | CX  | AG  | Action                                                                                                                                                 |
| ------------------------------------------------------------ | ------------------------------------------------- | --- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Live session detection                                       | ✅ PID registry (`collector.ts`)                  | ❌  | ❌  | M7: codex has no PID registry — detect via app-server/`ps` or open rollout file mtime+lock heuristic; agy via `conversation_summaries.not_fully_idle`  |
| Recent session list                                          | ✅ transcript mtime, top 60, title/cwd enrichment | ❌  | ❌  | M7: codex = walk `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`; agy = read `conversation_summaries.db` (title/preview/status/workspace_uris for free) |
| Resume / fork / continue                                     | ✅ declared (`resume:true, fork:true`)            | ❌  | ❌  | M7: codex `resume/fork/exec resume`; agy `--conversation/-c` (fork: none observed → declare false)                                                     |
| Background agents (`claude --bg`, `claude agents`, jobs dir) | ❌ not surfaced                                   | ❌  | ❌  | M4x-P1: enumerate `~/.claude/jobs/<id>/` + daemon status as a session source; codex equivalent = cloud tasks (P2)                                      |
| Named sessions / titles                                      | ✅ aiTitle/custom name enrich                     | ❌  | ❌  | M7 (agy: `title` column; codex: `thread_name_updated` event)                                                                                           |

## B. Transcript parsing → M6 renderer registry

| Record kind (claude)                                                                                                                                     | Parser today                                     | M6 renderer needed                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| user text / command chip                                                                                                                                 | ✅ parsed (`parser.ts` recordToItems)            | message bubble + command chip (exists in ChatItem form)                                                                                                    |
| assistant text                                                                                                                                           | ✅                                               | message bubble                                                                                                                                             |
| assistant `tool_use`                                                                                                                                     | 🟡 one-line `toolDetail` summary; knows 11 tools | **P0**: per-tool renderer registry for the ~45 SDK tools + `mcp__*` + generic fallback; Edit/Write need diff view, Bash needs cmd+output pairing           |
| `tool_result` (user-carried)                                                                                                                             | ❌ dropped                                       | **P0**: pair with tool_use id; render output/truncation/error state                                                                                        |
| `thinking` blocks                                                                                                                                        | ❌ deliberately dropped                          | **P0**: collapsible reasoning section (parser must emit, GUI collapses by default)                                                                         |
| sidechain records (`isSidechain`)                                                                                                                        | ❌ dropped                                       | **P0**: subagent thread grouping (Agent/Task tool call → nested thread); today the GUI shows nothing of multi-agent work, which claude 2.x is built around |
| `isMeta` records                                                                                                                                         | ❌ dropped                                       | OK to keep dropping (fallback chip when unknown)                                                                                                           |
| `system:*` (9 subtypes: stop_hook_summary, compact_boundary, api_error, turn_duration, away_summary, local_command, scheduled_task_fire, bridge_status…) | ❌ dropped                                       | **P1**: compact divider, hook chip, error banner, `!cmd` output chip; generic system-event chip fallback                                                   |
| `attachment`                                                                                                                                             | ❌ dropped                                       | P1: attachment chip                                                                                                                                        |
| `queue-operation`                                                                                                                                        | ❌ dropped                                       | P1: queued-prompt indicator                                                                                                                                |
| `file-history-snapshot`                                                                                                                                  | ❌ dropped                                       | P1: checkpoint marker (rewind affordance later)                                                                                                            |
| session-meta stream (`mode`, `permission-mode`, `agent-name`, `ai-title`, `custom-title`, `last-prompt`, `bridge-session`)                               | 🟡 only aiTitle via collector tail-grep          | P1: fold into session state (not chat items); permission-mode changes as event chips                                                                       |
| `image` / `document` content blocks                                                                                                                      | ❌ dropped                                       | P1: image thumb / doc chip                                                                                                                                 |
| unknown/future kinds                                                                                                                                     | ✅ unparsed → honest event item                  | keep as the mandatory generic fallback                                                                                                                     |
| TodoWrite / TaskCreate / TaskUpdate / Workflow / AskUserQuestion options / ExitPlanMode plan text                                                        | 🟡 one-line summaries                            | **P0** for AskUserQuestion (options + chosen answer) and ExitPlanMode (render the plan md); P1 for Todo/Task/Workflow progress views                       |

Codex record kinds M7 parser must map (from `codex.md` §7): `session_meta`,
`turn_context`, `response_item{message, reasoning, function_call, function_call_output,
web_search_call, custom_tool_call(_output), tool_search_call(_output)}`,
`event_msg{15 types}`, `compacted`. Tool renderers reuse the M6 registry via a
name-mapping layer (`exec_command→Bash-like`, `update_plan→Todo-like`, `spawn_agent→
subagent thread`, `click/js/get_app_state→computer-use chip`). Token usage comes from
`event_msg:token_count` (statusline-equivalent data claude gets from statusLine stdin).

agy: M7 collector renders summary-level cards from `conversation_summaries.db`; step-level
rendering is a separate spike (blob reverse-engineering) — do NOT promise it for v1.

## C. Capabilities / probe / driver

| Feature                      | CL                                                           | CX                | AG  | Action                                                                                                                                                                       |
| ---------------------------- | ------------------------------------------------------------ | ----------------- | --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Honest capability matrix     | ✅ `capabilities.ts`                                         | ❌                | ❌  | M7: fill from surveys (codex: transcript:'jsonl', headless:'exec-json', hooks:'rich'; agy: transcript:'sqlite-summary', headless:'print-text', hooks:'basic')                |
| Probe parses live CLI        | ✅ permission modes from `--help`                            | ❌                | ❌  | M7: codex probe = `codex features list` + `--help`; agy probe = `agy models` + `--help`                                                                                      |
| Permission modes             | ✅ parsed (`auto`,`manual` picked up live)                   | ❌                | ❌  | M7: codex = approval_policy×sandbox_mode matrix (2 dials, not 1 — SDK may need a richer shape); agy = `--dangerously-skip-permissions`/`--sandbox` only                      |
| PTY driver + keymap + quirks | ✅ ShiftTab prime, CtrlU clear, safe answerMenu              | ❌ (generic only) | ❌  | M7: per-tool keymaps + quirk engines; verify claude ShiftTab cycle still normal→acceptEdits→plan on 2.1.201 (new `auto` mode may have entered the cycle) — **M4x-P0 verify** |
| Headless co-drive            | 🟡 declared, not driven                                      | ❌                | ❌  | M7: codex `exec --json` is the cleanest co-drive of all three; also evaluate `codex app-server` JSON-RPC before betting on PTY                                               |
| Model registry               | 🟡 discovered + fallback aliases — **missing `fable` alias** | ❌                | ❌  | M4x-P0: add `fable`; M7: agy `agy models` parse; codex from config/model_catalog                                                                                             |
| Accounts (whoami/usage)      | ✅ allowlisted oauthAccount read; usage=tier note            | ❌                | ❌  | M7: codex `auth.json`/`codex login status`; agy google_accounts.json is credential-adjacent — read nothing, declare whoami:false until a safe field is identified            |

## D. Harness surfacing (files, hooks, config)

| Feature               | CL                                                          | CX  | AG  | Action                                                                                                                                                                                                                                                                                                                                |
| --------------------- | ----------------------------------------------------------- | --- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Harness file catalog  | 🟡 6 specs (2×CLAUDE.md, 2×settings.json, skills/, agents/) | ❌  | ❌  | M4x-P0: add `~/.claude/commands/`, `.claude/settings.local.json`, `.mcp.json`, `keybindings.json`, `CLAUDE.local.md`, plugins dir, memory dir. M7: codex = config.toml/AGENTS.md(×2)/profiles/`.agents/skills`/requirements.toml; agy = GEMINI.md/.antigravity.md/AGENTS.md/settings.json/keybindings.json/mcp_config.json/hooks.json |
| Hook injection        | ✅ 7 hooks, atomic merge, byte-identical uninstall          | ❌  | ❌  | M7-codex: TOML `[[hooks.*]]` injection **+ trust-hash UX** (cannot silently activate — see codex.md §4; injector must surface "approve in /hooks" state in `verify()`); M7-agy: hooks.json (failing hook = deny — ship fail-open wrappers)                                                                                            |
| Hook event coverage   | 🟡 7 of 30 events                                           | —   | —   | M4x-P1: add TaskCompleted/SubagentStart/SubagentStop/PostToolUseFailure/PermissionRequest listeners for richer panel telemetry (user's own settings already prove these fire)                                                                                                                                                         |
| Statusline data feed  | ❌                                                          | ❌  | ❌  | M6-P1: claude statusLine command shim → live cost/context/PR/worktree per session (richest telemetry, zero transcript parsing); codex equivalent = `tui.status_line` config + token_count events                                                                                                                                      |
| Slash-command catalog | 🟡 'discoverable' (user commands only)                      | ❌  | ❌  | M4x-P1: ship the ~100 built-in list (source-tagged builtin-maybe-stale); M7: codex ~45 TUI commands static list                                                                                                                                                                                                                       |
| MCP config surfacing  | ❌                                                          | ❌  | ❌  | P1 all tools: read-only list of configured servers (claude `.mcp.json`+settings; codex `mcp_servers.*`; agy `mcp_config.json`)                                                                                                                                                                                                        |
| Plugins surfacing     | ❌                                                          | ❌  | ❌  | P2: list installed plugins (all three have plugin CLIs)                                                                                                                                                                                                                                                                               |

## E. Feature systems (GUI-level)

| System                            | CL  | M6/M7 action                                                                                            |
| --------------------------------- | --- | ------------------------------------------------------------------------------------------------------- |
| Workflows / goals / loops         | ❌  | P1: render Workflow tool records + `pendingWorkflowCount`; goal state chip. Codex `/goal` parity exists |
| Teams / SendMessage               | ❌  | P1: teammate messages already appear as tool records — render; full team view P2                        |
| Checkpoint / rewind               | ❌  | P2: snapshot markers first (P1 render), rewind trigger later (risk: destructive)                        |
| Remote control / teleport / cloud | ❌  | P2: badge only (bridge-session records observed); no control-plane integration in v1                    |
| Worktree sessions                 | ❌  | P1: show worktree name/branch (statusline provides it)                                                  |
| Sandboxing (codex)                | ❌  | M7: expose sandbox_mode/approval_policy as the codex "permission mode" pair                             |

## Prioritized backlog

**P0 — must-have for a v1 "parity" claim (in order):**

1. **M6 renderer registry**: tool_use/tool_result pairing, per-tool renderers (Bash, Edit/Write diff, Read, Grep/Glob, Agent/Task, AskUserQuestion with options, ExitPlanMode plan view), generic fallback for unknown tools AND unknown record kinds. (Biggest visible gap; everything else renders through it.)
2. **M6 thinking blocks** — parser emits, GUI collapses. Claude 2.x sessions are thinking-heavy; dropping them misrepresents the session.
3. **M6 sidechain/subagent threads** — group `isSidechain` records under their Agent/Task call; without this, multi-agent sessions look empty.
4. **M4x adapter fixes**: add `fable` model alias; verify ShiftTab permission cycle against 2.1.201 (`auto`/`manual` modes); extend harness-file catalog (commands dir, settings.local.json, .mcp.json, keybindings).
5. **M7 codex deep adapter (read path)**: rollout collector + parser mapping §B; probe via `features list`; capability matrix; AGENTS.md/config harness files. Write path (drive) can ship PTY-first via generic keymap.
6. **M7 codex hooks injector with trust UX** — config write + explicit "pending approval in /hooks" status; never claim installed=active.

**P1 — v1.1:** 7. M6 system-record chips (compact divider, hook summaries, api_error banner, local_command output) + attachment/queue/snapshot markers + image blocks. 8. M6 statusline shim (claude) + codex token_count → unified live telemetry bar. 9. M7 agy adapter: summaries-db collector, models probe, GEMINI.md/hooks.json harness files, PTY drive. (Deep step parsing explicitly OUT — separate spike.) 10. M4x: built-in slash-command catalog; extra hook listeners (TaskCompleted, SubagentStart/Stop, PostToolUseFailure); background-agent (jobs dir) session source. 11. Codex headless co-drive via `exec --json` (and an app-server JSON-RPC spike).

**P2:** plugins/MCP surfacing, teams view, rewind trigger, cloud/remote badges, agy step-blob spike.
