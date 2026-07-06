/**
 * The four built-in layout templates (plan §레이아웃 템플릿). Builders, not
 * frozen JSON: they adapt to whatever sessions exist right now. Panels whose
 * real implementation is a later packet materialize as HONEST placeholders
 * (PlaceholderPanel) — visibly labeled, never fake surfaces.
 */
import type { DockviewApi } from 'dockview';
import type { FleetSession } from '../api/types';

export interface BuildContext {
  projectId: string;
  sessions: FleetSession[];
}

function firstSession(ctx: BuildContext): FleetSession | undefined {
  return ctx.sessions.find((s) => s.live) ?? ctx.sessions[0];
}

function addSessionOrPlaceholder(
  api: DockviewApi,
  ctx: BuildContext,
  id: string,
  position?: Parameters<DockviewApi['addPanel']>[0]['position'],
): void {
  const session = firstSession(ctx);
  if (session) {
    api.addPanel({
      id,
      component: 'session',
      params: { sessionId: session.id, adapterId: session.tool },
      ...(position ? { position } : {}),
    });
  } else {
    api.addPanel({
      id,
      component: 'placeholder',
      params: { panelKind: 'session-empty' },
      ...(position ? { position } : {}),
    });
  }
}

export type LayoutBuilder = (api: DockviewApi, ctx: BuildContext) => void;

/** 대화 중심: 플릿(좌) + 세션(중앙). */
function buildChat(api: DockviewApi, ctx: BuildContext): void {
  api.addPanel({ id: 'fleet', component: 'fleet' });
  addSessionOrPlaceholder(api, ctx, 'session-main', {
    referencePanel: 'fleet',
    direction: 'right',
  });
  api.getPanel('fleet')?.api.setSize({ width: 280 });
}

/** IDE형: 트리(placeholder) + 세션 + 에디터/diff(placeholder). */
function buildIde(api: DockviewApi, ctx: BuildContext): void {
  api.addPanel({ id: 'files', component: 'placeholder', params: { panelKind: 'files' } });
  addSessionOrPlaceholder(api, ctx, 'session-main', {
    referencePanel: 'files',
    direction: 'right',
  });
  api.addPanel({
    id: 'editor',
    component: 'placeholder',
    params: { panelKind: 'editor' },
    position: { referencePanel: 'session-main', direction: 'right' },
  });
  api.addPanel({
    id: 'diff',
    component: 'placeholder',
    params: { panelKind: 'diff' },
    position: { referencePanel: 'editor', direction: 'below' },
  });
  api.getPanel('files')?.api.setSize({ width: 240 });
}

/** 관제형: 플릿 + 세션 + 터미널들. */
function buildOps(api: DockviewApi, ctx: BuildContext): void {
  api.addPanel({ id: 'fleet', component: 'fleet' });
  addSessionOrPlaceholder(api, ctx, 'session-main', {
    referencePanel: 'fleet',
    direction: 'right',
  });
  const live = ctx.sessions.filter((s) => s.live && s.origin === 'paneld').slice(0, 2);
  live.forEach((s, i) => {
    api.addPanel({
      id: `terminal-${s.id}`,
      component: 'terminal',
      params: { sessionId: s.id, mode: 'ro' },
      position:
        i === 0
          ? { referencePanel: 'session-main', direction: 'below' }
          : { referencePanel: `terminal-${live[0]!.id}`, direction: 'right' },
    });
  });
  if (live.length === 0) {
    api.addPanel({
      id: 'terminal-empty',
      component: 'placeholder',
      params: { panelKind: 'terminal-empty' },
      position: { referencePanel: 'session-main', direction: 'below' },
    });
  }
  api.getPanel('fleet')?.api.setSize({ width: 280 });
}

/** 미리보기형: 세션 + 프리뷰(placeholder). */
function buildPreview(api: DockviewApi, ctx: BuildContext): void {
  addSessionOrPlaceholder(api, ctx, 'session-main');
  api.addPanel({
    id: 'preview',
    component: 'placeholder',
    params: { panelKind: 'preview' },
    position: { referencePanel: 'session-main', direction: 'right' },
  });
}

export const BUILTIN_LAYOUTS: Record<string, { labelKey: string; build: LayoutBuilder }> = {
  chat: { labelKey: 'layout.builtin.chat', build: buildChat },
  ide: { labelKey: 'layout.builtin.ide', build: buildIde },
  ops: { labelKey: 'layout.builtin.ops', build: buildOps },
  preview: { labelKey: 'layout.builtin.preview', build: buildPreview },
};
