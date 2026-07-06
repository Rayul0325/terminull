/**
 * 상세보기 side panel — renders a DetailView (registry.ts contract) inside the
 * session panel. v1 supports text fully; markdown shows raw text WITH an
 * explicit "미리보기 준비 전" label; diff/html state their unavailability
 * honestly (their real renderers are separate packets: RENDERERS.md).
 */
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { DetailView } from '../../renderers/registry';

export function DetailPanel({
  view,
  onClose,
}: {
  view: DetailView;
  onClose: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const title = view.titleKey ? t(view.titleKey) : (view.title ?? '');
  const { content } = view;

  return (
    <div
      style={{
        width: 'min(45%, 560px)',
        borderLeft: '1px solid var(--tn-border)',
        display: 'flex',
        flexDirection: 'column',
        minWidth: 260,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 10px',
          borderBottom: '1px solid var(--tn-border)',
        }}
      >
        <strong
          style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {title}
        </strong>
        {content.kind === 'markdown' ? (
          <span className="tn-chip">{t('detail.markdownPending')}</span>
        ) : null}
        <button type="button" className="tn-btn" onClick={onClose}>
          {t('common.close')}
        </button>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: 10 }}>
        {content.kind === 'text' || content.kind === 'markdown' ? (
          <pre
            style={{
              margin: 0,
              whiteSpace: 'pre-wrap',
              fontFamily: 'var(--tn-font-mono)',
              fontSize: 12,
            }}
          >
            {content.value}
          </pre>
        ) : (
          <div style={{ color: 'var(--tn-fg-muted)' }}>
            {t('detail.kindUnavailable', { kind: content.kind })}
          </div>
        )}
      </div>
    </div>
  );
}
