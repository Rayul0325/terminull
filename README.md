# Terminull

**Terminull — one panel for every CLI coding agent.** Terminull is a single
control surface that hosts, drives, and manages command-line coding agents
(Claude Code, Codex, agy, ACP-speaking tools, and generic CLIs) from one place.
It is a pnpm + TypeScript monorepo: a shared core, per-tool adapters behind a
common adapter SDK, a session host for PTY-backed processes, a server, a CLI, and
a React web panel with first-class internationalization (ko / en, ja scaffolded).

> **한 줄 소개:** Terminull — 모든 CLI 코딩 에이전트를 위한 하나의 패널.

**Status: pre-alpha (M0 skeleton).** This repository currently contains only the
build/test/lint scaffolding and typed placeholder exports — no real features yet.
APIs, package boundaries, and everything else are expected to change without
notice. Do not depend on anything here.

## Layout

| Package                      | Purpose                                                             |
| ---------------------------- | ------------------------------------------------------------------- |
| `@terminull/shared`          | Shared types and constants used across the monorepo.                |
| `@terminull/core`            | Core orchestration logic (depends on shared).                       |
| `@terminull/session-host`    | PTY-backed process/session host (node-pty declared, not wired yet). |
| `@terminull/adapter-sdk`     | Common contract every tool adapter implements.                      |
| `@terminull/adapter-claude`  | Adapter for Claude Code.                                            |
| `@terminull/adapter-codex`   | Adapter for Codex.                                                  |
| `@terminull/adapter-agy`     | Adapter for agy.                                                    |
| `@terminull/adapter-acp`     | Adapter for ACP-speaking agents.                                    |
| `@terminull/adapter-generic` | Fallback adapter for generic CLIs.                                  |
| `@terminull/server`          | Backend server surface.                                             |
| `@terminull/manage-agent`    | Agent lifecycle management.                                         |
| `@terminull/cli`             | `terminull` command-line entry point.                               |
| `@terminull/web`             | Vite + React + TS web panel with react-i18next.                     |
| `@terminull/desktop`         | Desktop shell placeholder (Electron lands in M10).                  |

## Develop

```sh
corepack enable
pnpm install
pnpm -r build
pnpm -r test
pnpm lint
```
