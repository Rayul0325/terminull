/**
 * The editable Antigravity (`agy`) harness files the panel surfaces, each with
 * an en+ko label/description, a scope, and a risk band so the UI can warn before
 * opening a sensitive one. Paths resolve from the {@link HarnessContext} home.
 *
 * agy exposes NO hook mechanism (`hooks: 'none'`), so there is no
 * {@link HarnessInjector} — the panel can still let the user edit these files
 * directly:
 *  - `GEMINI.md` (`~/.gemini/GEMINI.md`) — prose instructions; `low` risk,
 *    absence is normal (`mayNotExist`).
 *  - antigravity `settings.json` (`~/.gemini/antigravity-cli/settings.json`) —
 *    toggles like `allowNonWorkspaceAccess` / `enableTelemetry`; `med` risk
 *    (loosening non-workspace access is security-relevant, but it does not
 *    execute arbitrary commands the way a hook config would).
 */
import os from 'node:os';
import path from 'node:path';
import type { HarnessContext, HarnessFileSpec } from '@terminull/adapter-sdk';

/** The `.gemini` home for a given context (agy stores its state under `.gemini`). */
function geminiHome(ctx: HarnessContext): string {
  return path.join(ctx.home ?? os.homedir(), '.gemini');
}

/** The agy harness-file catalog contributed by this adapter. */
export const agyHarnessFiles: HarnessFileSpec[] = [
  {
    id: 'agy.gemini.md',
    label: { en: 'GEMINI.md', ko: 'GEMINI.md' },
    description: {
      en: 'User-wide instructions agy applies to sessions (~/.gemini/GEMINI.md).',
      ko: 'agy가 세션에 적용하는 사용자 전역 지침 (~/.gemini/GEMINI.md).',
    },
    format: 'markdown',
    scope: 'user',
    riskLevel: 'low',
    pathResolver: (ctx) => path.join(geminiHome(ctx), 'GEMINI.md'),
    mayNotExist: true,
  },
  {
    id: 'agy.settings',
    label: { en: 'Antigravity settings.json', ko: 'Antigravity settings.json' },
    description: {
      en: 'Antigravity CLI settings: workspace-access and telemetry toggles (~/.gemini/antigravity-cli/settings.json). Loosening access is security-relevant — edit with care.',
      ko: 'Antigravity CLI 설정: 워크스페이스 접근·텔레메트리 토글 (~/.gemini/antigravity-cli/settings.json). 접근 완화는 보안에 영향을 주므로 주의해서 편집하세요.',
    },
    format: 'json',
    scope: 'user',
    riskLevel: 'med',
    pathResolver: (ctx) => path.join(geminiHome(ctx), 'antigravity-cli', 'settings.json'),
    mayNotExist: true,
  },
];
