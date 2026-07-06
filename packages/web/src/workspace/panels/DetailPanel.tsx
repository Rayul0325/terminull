/**
 * 상세보기 side panel — renders a DetailView (registry.ts contract) inside the
 * session panel. Text renders directly; markdown lazy-loads `marked` +
 * `dompurify` ONLY when a markdown detail is actually opened (code-split out
 * of the main bundle) and shows the honest "미리보기 준비 전" chip until that
 * chunk resolves; diff/html state their unavailability honestly (their real
 * renderers are separate packets: RENDERERS.md).
 *
 * Test coverage note: the lazy `marked`+`dompurify` branch depends on a real
 * dynamic import resolving inside a DOM environment, which node-based vitest
 * (renderToStaticMarkup, no jsdom) cannot exercise meaningfully — this file
 * intentionally has no colocated unit test for that path. Coverage is
 * manual/E2E (webapp-testing / Playwright), not vitest.
 */
import { useEffect, useState, type ReactElement } from 'react';
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
  const markdownSource = content.kind === 'markdown' ? content.value : undefined;

  // Sanitized HTML for the current markdown detail, or null while pending /
  // for non-markdown content. Reset whenever the panel switches to a
  // different view or source text so a stale render never survives.
  const [markdownHtml, setMarkdownHtml] = useState<string | null>(null);

  useEffect(() => {
    setMarkdownHtml(null);
    if (markdownSource === undefined) return;
    let cancelled = false;
    void (async () => {
      const [{ marked }, { default: DOMPurify }] = await Promise.all([
        import('marked'),
        import('dompurify'),
      ]);
      if (cancelled) return;
      const raw = marked.parse(markdownSource, { async: false });
      const clean = DOMPurify.sanitize(raw);
      if (!cancelled) setMarkdownHtml(clean);
    })();
    return () => {
      cancelled = true;
    };
  }, [view.id, markdownSource]);

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
        {content.kind === 'markdown' && markdownHtml === null ? (
          <span className="tn-chip">{t('detail.markdownPending')}</span>
        ) : null}
        <button type="button" className="tn-btn" onClick={onClose}>
          {t('common.close')}
        </button>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: 10 }}>
        {content.kind === 'markdown' && markdownHtml !== null ? (
          // SECURITY: the only dangerouslySetInnerHTML in this file — safe
          // BECAUSE `markdownHtml` is always DOMPurify.sanitize() output (see
          // the effect above) run over marked's parse of the raw markdown,
          // with DOMPurify's strict default config (no scripts, no inline
          // event handlers, no javascript:/data: URLs). Never fed raw input.
          <div className="tn-richtext" dangerouslySetInnerHTML={{ __html: markdownHtml }} />
        ) : content.kind === 'text' || content.kind === 'markdown' ? (
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
