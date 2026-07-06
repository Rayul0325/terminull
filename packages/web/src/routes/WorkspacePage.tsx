/**
 * /workspace/:projectId — the dockview workspace, LAZY-loaded so dockview
 * stays out of the shell chunk. projectId 'all' shows every session; a
 * URL-encoded cwd filters to that project. ?focus=<sessionId> opens that
 * session's panel on entry (deep-link half of /session/:sid).
 */
import { Suspense, lazy, type ReactElement } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { cwdOfProjectId, useFleetStore } from '../stores/fleet';

const DockWorkspace = lazy(() =>
  import('../workspace/DockWorkspace').then((m) => ({ default: m.DockWorkspace })),
);

export function WorkspacePage(): ReactElement {
  const { t } = useTranslation();
  const params = useParams<{ projectId: string }>();
  const [search] = useSearchParams();
  const projectId = params.projectId ?? 'all';
  const cwd = cwdOfProjectId(projectId);
  const snapshot = useFleetStore((s) => s.snapshot);
  const sessions = (snapshot?.sessions ?? []).filter((s) => cwd === null || s.cwd === cwd);
  const focus = search.get('focus') ?? undefined;

  return (
    <div style={{ height: '100%' }}>
      <Suspense
        fallback={
          <div style={{ padding: 16, color: 'var(--tn-fg-muted)' }}>{t('common.loading')}</div>
        }
      >
        <DockWorkspace
          projectId={projectId}
          sessions={sessions}
          {...(focus !== undefined ? { focusSessionId: focus } : {})}
        />
      </Suspense>
    </div>
  );
}
