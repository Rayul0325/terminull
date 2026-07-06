/**
 * Terminal panel — lazy wrapper so @xterm lands in its own chunk, keeping the
 * shell bundle inside the 180KB budget.
 */
import { Suspense, lazy, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { IDockviewPanelProps } from 'dockview';
import type { TerminalPanelParams } from '../panelRegistry';

const TerminalView = lazy(() => import('../../terminal/TerminalView'));

export function TerminalPanel(props: IDockviewPanelProps<TerminalPanelParams>): ReactElement {
  const { t } = useTranslation();
  const sessionId = props.params?.sessionId ?? '';
  const mode = props.params?.mode === 'rw' ? 'rw' : 'ro';
  if (!sessionId) {
    return <div style={{ padding: 12, color: 'var(--tn-danger)' }}>{t('session.noId')}</div>;
  }
  return (
    <Suspense
      fallback={
        <div style={{ padding: 12, color: 'var(--tn-fg-muted)' }}>{t('common.loading')}</div>
      }
    >
      <TerminalView sessionId={sessionId} mode={mode} />
    </Suspense>
  );
}
