/**
 * The editable Claude Code harness files the panel surfaces, each with an en+ko
 * label/description, a scope, and a risk band so the UI can warn before opening
 * a dangerous one. Paths resolve from the {@link HarnessContext} (home / cwd).
 *
 * Risk bands: CLAUDE.md files are `low` (prose that shapes behaviour but grants
 * nothing); `settings.json`/`settings.local.json` and `.mcp.json` are `high`
 * (they wire hooks/permissions or launch MCP processes and can execute arbitrary
 * commands); the skills/agents/commands DIRECTORIES and `keybindings.json` are
 * `med` (they extend behaviour or rebind keys but are not themselves a
 * permission grant).
 */
import os from 'node:os';
import path from 'node:path';
import type { HarnessContext, HarnessFileSpec } from '@terminull/adapter-sdk';

function home(ctx: HarnessContext): string {
  return ctx.home ?? os.homedir();
}
function cwd(ctx: HarnessContext): string {
  return ctx.cwd ?? process.cwd();
}

/** The Claude Code harness-file catalog contributed by this adapter. */
export const claudeHarnessFiles: HarnessFileSpec[] = [
  {
    id: 'claude.md.global',
    label: { en: 'Global CLAUDE.md', ko: '전역 CLAUDE.md' },
    description: {
      en: 'User-wide instructions applied to every project (~/.claude/CLAUDE.md).',
      ko: '모든 프로젝트에 적용되는 사용자 전역 지침 (~/.claude/CLAUDE.md).',
    },
    format: 'markdown',
    scope: 'user',
    riskLevel: 'low',
    pathResolver: (ctx) => path.join(home(ctx), '.claude', 'CLAUDE.md'),
    mayNotExist: true,
  },
  {
    id: 'claude.md.project',
    label: { en: 'Project CLAUDE.md', ko: '프로젝트 CLAUDE.md' },
    description: {
      en: 'Project-local instructions in the working directory (./CLAUDE.md).',
      ko: '작업 디렉터리의 프로젝트 지침 (./CLAUDE.md).',
    },
    format: 'markdown',
    scope: 'project',
    riskLevel: 'low',
    pathResolver: (ctx) => path.join(cwd(ctx), 'CLAUDE.md'),
    mayNotExist: true,
  },
  {
    id: 'claude.settings',
    label: { en: 'Global settings.json', ko: '전역 settings.json' },
    description: {
      en: 'User settings: hooks, permissions, env. Executes commands — edit with care.',
      ko: '사용자 설정: 훅·권한·환경변수. 명령을 실행하므로 주의해서 편집하세요.',
    },
    format: 'json',
    scope: 'user',
    riskLevel: 'high',
    pathResolver: (ctx) => path.join(home(ctx), '.claude', 'settings.json'),
    mayNotExist: true,
  },
  {
    id: 'claude.settings.project',
    label: { en: 'Project settings.json', ko: '프로젝트 settings.json' },
    description: {
      en: 'Project-local settings (./.claude/settings.json). Executes commands — edit with care.',
      ko: '프로젝트 로컬 설정 (./.claude/settings.json). 명령을 실행하므로 주의해서 편집하세요.',
    },
    format: 'json',
    scope: 'project',
    riskLevel: 'high',
    pathResolver: (ctx) => path.join(cwd(ctx), '.claude', 'settings.json'),
    mayNotExist: true,
  },
  {
    id: 'claude.skills',
    label: { en: 'Skills directory', ko: '스킬 디렉터리' },
    description: {
      en: 'User skills folder (~/.claude/skills). Each subfolder is a skill.',
      ko: '사용자 스킬 폴더 (~/.claude/skills). 각 하위 폴더가 하나의 스킬입니다.',
    },
    format: 'other',
    scope: 'user',
    riskLevel: 'med',
    pathResolver: (ctx) => path.join(home(ctx), '.claude', 'skills'),
    mayNotExist: true,
  },
  {
    id: 'claude.agents',
    label: { en: 'Agents directory', ko: '에이전트 디렉터리' },
    description: {
      en: 'User subagents folder (~/.claude/agents). Each file defines a subagent.',
      ko: '사용자 서브에이전트 폴더 (~/.claude/agents). 각 파일이 서브에이전트를 정의합니다.',
    },
    format: 'other',
    scope: 'user',
    riskLevel: 'med',
    pathResolver: (ctx) => path.join(home(ctx), '.claude', 'agents'),
    mayNotExist: true,
  },
  {
    id: 'claude.commands',
    label: { en: 'Commands directory', ko: '커맨드 디렉터리' },
    description: {
      en: 'User slash-commands folder (~/.claude/commands). Each file adds a /command; a command can run shell — extends behaviour.',
      ko: '사용자 슬래시 커맨드 폴더 (~/.claude/commands). 각 파일이 /커맨드를 추가하며 셸을 실행할 수 있습니다.',
    },
    format: 'other',
    scope: 'user',
    riskLevel: 'med',
    pathResolver: (ctx) => path.join(home(ctx), '.claude', 'commands'),
    mayNotExist: true,
  },
  {
    id: 'claude.settings.local',
    label: { en: 'Project local settings.local.json', ko: '프로젝트 로컬 settings.local.json' },
    description: {
      en: 'Untracked project overrides (./.claude/settings.local.json): hooks, permissions, env. Executes commands — highest-risk edit.',
      ko: '추적되지 않는 프로젝트 재정의 (./.claude/settings.local.json): 훅·권한·환경변수. 명령을 실행하므로 가장 위험한 편집입니다.',
    },
    format: 'json',
    scope: 'project',
    riskLevel: 'high',
    pathResolver: (ctx) => path.join(cwd(ctx), '.claude', 'settings.local.json'),
    mayNotExist: true,
  },
  {
    id: 'claude.mcp.project',
    label: { en: 'Project MCP config (.mcp.json)', ko: '프로젝트 MCP 설정 (.mcp.json)' },
    description: {
      en: 'Project MCP servers (./.mcp.json). Each configured server launches a process — edit with care.',
      ko: '프로젝트 MCP 서버 (./.mcp.json). 설정된 각 서버가 프로세스를 실행하므로 주의해서 편집하세요.',
    },
    format: 'json',
    scope: 'project',
    riskLevel: 'high',
    pathResolver: (ctx) => path.join(cwd(ctx), '.mcp.json'),
    mayNotExist: true,
  },
  {
    id: 'claude.keybindings',
    label: { en: 'Keybindings', ko: '키 바인딩' },
    description: {
      en: 'User keyboard shortcuts (~/.claude/keybindings.json). Rebinds keys; no command execution.',
      ko: '사용자 키보드 단축키 (~/.claude/keybindings.json). 키를 재지정하며 명령을 실행하지 않습니다.',
    },
    format: 'json',
    scope: 'user',
    riskLevel: 'med',
    pathResolver: (ctx) => path.join(home(ctx), '.claude', 'keybindings.json'),
    mayNotExist: true,
  },
];
