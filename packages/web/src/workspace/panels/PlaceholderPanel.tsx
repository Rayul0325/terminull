/**
 * Honest stand-in for panel kinds that exist in the layout-template contract
 * but are not implemented yet (editor / diff / preview / board / files). It
 * says so explicitly — a placeholder must never look like a working panel.
 */
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { IDockviewPanelProps } from 'dockview';
import type { PlaceholderPanelParams } from '../panelRegistry';

export function PlaceholderPanel(props: IDockviewPanelProps<PlaceholderPanelParams>): ReactElement {
  const { t } = useTranslation();
  const kind = props.params?.panelKind ?? 'unknown';
  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        color: 'var(--tn-fg-muted)',
      }}
    >
      <span className="tn-chip">{t(`panel.kind.${kind}`, kind)}</span>
      <div>{t('panel.placeholder.notice')}</div>
    </div>
  );
}
