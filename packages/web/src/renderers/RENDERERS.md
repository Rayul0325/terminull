# Renderer work packets — parallel build contract

Audience: parallel renderer workers (opus). Read `registry.ts` FIRST — it is the
binding contract (match axes, resolution, claude raw shapes, pairing, honesty
rules). This file only enumerates the packets.

## Hard rules (repeated from registry.ts — violations fail review)

1. One packet = one renderer = ONE new file (`tools/<Name>Card.tsx` or
   `kinds/<Kind>View.tsx`) + ONE colocated test (`*.test.tsx` or logic-level
   `*.test.ts`) + ONE import/registration line appended to `index.ts`.
   No other file may be touched. No cross-packet imports.
2. Fixture source of truth: `docs/parity/claude-code.md` §7 (record kinds,
   observed tool list) and the claude parser golden fixture
   `packages/adapters/claude/test/fixtures/golden-session.jsonl`. When a tool's
   input schema is unclear, obtain `sdk-tools.d.ts` via a SANDBOX install of
   `@anthropic-ai/claude-code` (it is NOT vendored in this repo; the installed
   CLI is a single binary) — never guess field names.
3. Every string through `ctx.t` with keys added to `src/i18n/keys.ts` +
   `locales/ko.json` + `locales/en.json` (the parity test fails otherwise).
4. Honesty: absent data renders as an explicit absent/확인-중 state. Never
   fabricate output, durations, or success states. Paired results come ONLY
   from `ctx.pairedResult`.
5. Match as narrowly as truthful: tool renderers use
   `{ kind: 'tool_call', toolName: '<Name>' }` (adapter-agnostic — codex/M7
   maps its names onto the same registry via a name-mapping layer).

## Seeded (done — reference implementations)

- `generic` (fallback), `kind.message` (TextMessage), `tool.bash` (BashCard,
  pairing + terminal jump), `tool.write` (WriteCard, 상세보기 detail contract).

## P0 packets (gap-matrix order)

| Packet                | Match                                          | Notes                                                                                                                                                          |
| --------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| kind.tool_result      | `{kind:'tool_result'}`                         | standalone (unpaired) result card; error state from `raw.isError`                                                                                              |
| kind.reasoning        | `{kind:'reasoning'}`                           | collapsed-by-default thinking block (P0 #2)                                                                                                                    |
| kind.sidechain        | `{kind:'sidechain'}`                           | subagent thread marker; group under nearest Agent/Task tool_call (P0 #3)                                                                                       |
| tool.edit             | `{kind:'tool_call',toolName:'Edit'}`           | diff detail via `openDetail({content:{kind:'diff',before:old_string,after:new_string,path:file_path}})`; lazy `@git-diff-view/react` in the DetailPanel packet |
| tool.read             | `Read`                                         | path + offset/limit chip                                                                                                                                       |
| tool.grep / tool.glob | `Grep` / `Glob`                                | pattern + scope chips (two packets)                                                                                                                            |
| tool.agent            | `Agent`                                        | subagent launch card; anchors sidechain grouping                                                                                                               |
| tool.askuserquestion  | `AskUserQuestion`                              | options list + chosen answer from paired result                                                                                                                |
| tool.exitplanmode     | `ExitPlanMode`                                 | plan md via detail panel (markdown kind)                                                                                                                       |
| tool.todowrite        | `TodoWrite`                                    | todo checklist card                                                                                                                                            |
| detail.markdown       | (DetailPanel upgrade, not a ChatItem renderer) | real markdown rendering in the side panel; until it lands the panel shows plain text with an honest label                                                      |

## P1 packets

- `kind.system` subtypes: compact divider (`compact_boundary`), hook chip
  (`stop_hook_summary`), api_error banner, `local_command` output chip —
  subtype read from `raw`, one packet per subtype family.
- Remaining SDK tools, one packet each (claude-code.md §7 union, ~45 names):
  `TaskCreate TaskUpdate TaskGet TaskList TaskStop TaskOutput Workflow Skill
ToolSearch WebSearch WebFetch SendMessage Monitor StructuredOutput
ScheduleWakeup EnterPlanMode PushNotification CronCreate CronList CronDelete
EnterWorktree ExitWorktree NotebookEdit FileEdit FileWrite FileRead REPL
Artifact ClaudeDesign ListMcpResources ReadMcpResource ReadMcpResourceDir
Mcp Projects RemoteTrigger ReportFindings TaskGet ShowOnboardingRolePicker`
  — simple chip cards are acceptable; do NOT build elaborate UIs without a
  fixture proving the input shape.
- `tool.mcp-generic` — `{kind:'tool_call',toolName:'mcp__*'}` wildcard card
  (server/tool name split out of the `mcp__<server>__<tool>` name).
- Composer upgrades (separate from renderers): slash-command autocomplete,
  model picker, permission-mode picker — blocked on server catalog endpoints.

## Verification per packet

`pnpm --filter @terminull/web test` green (your test + i18n parity),
`pnpm lint` green (i18n literal-string rule), and a one-line note in the PR
body naming the fixture your test uses.
