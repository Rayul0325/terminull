# Golden fixtures needed — parity as tests

Purpose: every record kind / schema surface named in the parity docs gets a golden fixture
so M6/M7 parity is enforced by tests, not by this document rotting. Conventions: fixtures
live under the owning package (`packages/adapters/<tool>/test/fixtures/`), are SANITIZED
captures from real sessions (paths → `/home/u/proj`, no tokens — mask as `[REDACTED]`, no
real prompts beyond placeholder text), and each file carries a `captured-with: <tool>
<version>` comment/sidecar so staleness is detectable.

## 1. Claude transcript JSONL (`adapters/claude/test/fixtures/transcript/`)

One `.jsonl` fixture per record kind (single line each unless noted):

- [ ] `user-text.jsonl` — plain user message (string content AND array-of-text variants)
- [ ] `user-command.jsonl` — `<command-name>/<command-args>` invocation
- [ ] `user-tool-result.jsonl` — tool_result block + `toolUseResult` envelope field (success, error, and truncated variants)
- [ ] `assistant-text.jsonl`, `assistant-thinking.jsonl`
- [ ] `assistant-tool-use-<tool>.jsonl` — one per P0 renderer: Bash, Read, Edit, Write, Glob, Grep, Agent, TaskCreate/TaskUpdate, AskUserQuestion, ExitPlanMode, TodoWrite, Workflow, Skill, WebFetch, WebSearch, SendMessage, StructuredOutput, ToolSearch, `mcp__server__tool`, plus one UNKNOWN tool name (fallback path)
- [ ] `sidechain-thread.jsonl` — Agent call + a few `isSidechain:true` records (multi-line; grouping test)
- [ ] `system-<subtype>.jsonl` × 9: stop_hook_summary, turn_duration, away_summary, api_error, compact_boundary, local_command, scheduled_task_fire, bridge_status, + one unknown subtype (fallback)
- [ ] `attachment.jsonl`, `queue-operation.jsonl`, `file-history-snapshot.jsonl`, `bridge-session.jsonl`
- [ ] session-meta stream: `mode.jsonl`, `permission-mode.jsonl`, `agent-name.jsonl`, `ai-title.jsonl`, `custom-title.jsonl`, `last-prompt.jsonl`
- [ ] `content-image.jsonl`, `content-document.jsonl`
- [ ] `torn-line.jsonl` — mid-write truncated JSON (unparsed-item path; exists in spirit in parser tests — make it a shared golden)
- [ ] `mixed-session.jsonl` — ~50-line realistic slice exercising ordering, ids, pairing

## 2. Claude harness surfaces (`adapters/claude/test/fixtures/harness/`)

- [ ] `settings-full.json` — every key group from claude-code.md §4 (values dummy)
- [ ] `settings-hooks-30events.json` — all 30 event names, incl. matcher variants
- [ ] `statusline-stdin.json` — full schema (§5) + minimal variant (only required fields)
- [ ] hook stdin payloads × key events: PreToolUse, PostToolUse, PostToolUseFailure, UserPromptSubmit, Stop, SubagentStart/Stop, TaskCompleted, PermissionRequest, SessionStart, PreCompact, Notification (capture live via a logging hook — payloads are docs-sourced today, needs empirical goldens)
- [ ] `sessions-registry/<pid>.json` — live-registry entry (exists in collector tests; promote to shared golden + add a stale-pid variant)
- [ ] `help-2.1.201.txt` — full `--help` (probe parsing regression; permission-mode choices line)
- [ ] `commands-dir/`, `agents-frontmatter.md`, `SKILL-frontmatter.md`, `plugin.json` — one exemplar each for harness-file catalog tests

## 3. Codex rollouts (`adapters/codex/test/fixtures/rollout/`)

- [ ] `session_meta.jsonl` (+ git payload variant), `turn_context.jsonl`, `compacted.jsonl`
- [ ] `response_item-<type>.jsonl` × 9: message, reasoning, function_call, function_call_output, web_search_call, custom_tool_call, custom_tool_call_output, tool_search_call, tool_search_output
- [ ] `event_msg-<type>.jsonl` × 15 (token_count, agent_message, user_message, task_started, task_complete, mcp_tool_call_end, exec_command_end, web_search_end, patch_apply_end, agent_reasoning, turn_aborted, dynamic_tool_call_request/response, context_compacted, thread_name_updated)
- [ ] `function_call-<name>.jsonl` for renderer mapping: exec_command, write_stdin, spawn_agent/wait_agent/close_agent, update_plan, view_image, click, js, automation_update, one `_mcp_app_tool`
- [ ] `exec-json-events.jsonl` — `codex exec --json` stream: thread.started → turn.completed (+ turn.failed variant)
- [ ] `config-full.toml` — every table from codex.md §3; `config-hooks.toml` — `[[hooks.*]]` blocks; `features-list.txt` — `codex features list` output (probe regression)
- [ ] `resumed-rollout.jsonl` — file with an append boundary (resume writes into the same file)

## 4. agy (`adapters/agy/test/fixtures/`)

- [ ] `conversation_summaries.sqlite` — 3 rows: idle, `not_fully_idle`, killed; one with `parent_conversation_id` (subagent nesting)
- [ ] `conversation-mini.sqlite` — real schema (all 7 tables), steps rows for each observed step_type {7,8,9,14,15,21,23,31,33,98,101,132} with EMPTIED blobs (structure-only until the enum spike lands)
- [ ] `agy-help.txt`, `agy-models.txt` — probe parsing goldens
- [ ] `keybindings.json`, `settings.json` exemplars; `hooks.json` once its shape is verified (currently UNVERIFIED — capture when first written)

## 5. Cross-tool conformance

- [ ] Extend `adapter-sdk/src/conformance.ts` with a "record-kind coverage" assertion: each adapter declares its known record kinds; the conformance runner feeds every fixture and asserts (a) no throws, (b) unknown kinds route to the fallback item, (c) knownKinds ⊇ the fixture manifest for that tool.
- [ ] `fixture-manifest.json` per tool — the machine-readable list M6's renderer registry tests iterate, so adding a fixture automatically extends renderer coverage requirements.

## Capture protocol

1. Claude/codex: copy single lines out of real transcripts (structural fields already
   enumerated in the parity docs), then sanitize text fields to lorem placeholders —
   NEVER commit real prompt/output content, paths outside `/home/u/proj`, or anything
   matching a credential pattern.
2. Hook payloads: register a temporary logging hook (`jq . >> capture.jsonl`) in a
   THROWAWAY `CLAUDE_CONFIG_DIR` session, drive one scripted turn per event, then strip.
3. agy sqlite: `sqlite3 <src> ".dump"` → edit blobs to `X''` → rebuild; keeps schema
   byte-honest without leaking content.
4. Every fixture PR must state the producing CLI version; bumping the surveyed version
   re-runs capture only for kinds whose parser tests fail (cheap staleness signal).
