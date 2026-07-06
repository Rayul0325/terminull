/**
 * /session/:sid deep link — resolves the session's project from the fleet and
 * forwards into the workspace with ?focus=. Unknown sessions land on the
 * 'all' workspace with the same focus param: the session panel itself reports
 * the honest not-found state (the server, not this router, is the authority).
 */
import { useEffect, type ReactElement } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { projectIdOf, useFleetStore } from '../stores/fleet';

export function SessionPage(): ReactElement {
  const { t } = useTranslation();
  const params = useParams<{ sid: string }>();
  const sid = params.sid ?? '';
  const snapshot = useFleetStore((s) => s.snapshot);
  const errorCode = useFleetStore((s) => s.errorCode);
  const refresh = useFleetStore((s) => s.refresh);

  useEffect(() => {
    if (!snapshot) void refresh();
  }, [snapshot, refresh]);

  if (!snapshot) {
    if (errorCode !== null) {
      return (
        <div style={{ padding: 16, color: 'var(--tn-danger)' }}>
          {t('fleet.loadFailed', { code: errorCode })}
        </div>
      );
    }
    return <div style={{ padding: 16, color: 'var(--tn-fg-muted)' }}>{t('common.loading')}</div>;
  }

  const session = snapshot.sessions.find((s) => s.id === sid);
  const projectId = session ? projectIdOf(session.cwd) : 'all';
  return <Navigate to={`/workspace/${projectId}?focus=${encodeURIComponent(sid)}`} replace />;
}
