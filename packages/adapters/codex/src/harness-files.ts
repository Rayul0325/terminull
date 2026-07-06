/**
 * The editable Codex CLI harness files the panel surfaces, each with an en+ko
 * label/description, a scope, and a risk band so the UI can warn before opening
 * a dangerous one.
 *
 * Risk bands: `AGENTS.md` files are `low` (prose that shapes behaviour but grants
 * nothing — safe); `config.toml` is `high` (it wires the notify hook, sandbox &
 * approval policies, model provider credentials-by-reference and per-project
 * trust tables — editing it changes what commands may run — danger).
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

/** The Codex CLI harness-file catalog contributed by this adapter. */
export const codexHarnessFiles: HarnessFileSpec[] = [
  {
    id: 'codex.agents.global',
    label: { en: 'Global AGENTS.md', ko: '전역 AGENTS.md' },
    description: {
      en: 'User-wide Codex instructions applied to every session (~/.codex/AGENTS.md).',
      ko: '모든 Codex 세션에 적용되는 사용자 전역 지침 (~/.codex/AGENTS.md).',
    },
    format: 'markdown',
    scope: 'user',
    riskLevel: 'low',
    pathResolver: (ctx) => path.join(home(ctx), '.codex', 'AGENTS.md'),
    mayNotExist: true,
  },
  {
    id: 'codex.agents.project',
    label: { en: 'Project AGENTS.md', ko: '프로젝트 AGENTS.md' },
    description: {
      en: 'Project-local Codex instructions in the working directory (./AGENTS.md).',
      ko: '작업 디렉터리의 프로젝트 Codex 지침 (./AGENTS.md).',
    },
    format: 'markdown',
    scope: 'project',
    riskLevel: 'low',
    pathResolver: (ctx) => path.join(cwd(ctx), 'AGENTS.md'),
    mayNotExist: true,
  },
  {
    id: 'codex.config',
    label: { en: 'config.toml', ko: 'config.toml' },
    description: {
      en: 'Codex config: notify hook, sandbox/approval policy, model provider, and per-project trust tables. Changes what commands may run — edit with care.',
      ko: 'Codex 설정: notify 훅·샌드박스/승인 정책·모델 공급자·프로젝트별 신뢰 테이블. 실행 가능한 명령을 바꾸므로 주의해서 편집하세요.',
    },
    format: 'toml',
    scope: 'user',
    riskLevel: 'high',
    pathResolver: (ctx) => path.join(home(ctx), '.codex', 'config.toml'),
    mayNotExist: true,
  },
];
