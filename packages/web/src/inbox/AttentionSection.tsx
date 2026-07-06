/**
 * "지금 확인이 필요한 일" — the attention inbox. Confirmations are seeded from
 * `GET /api/confirmations` on connect (M9 W7) and answered INLINE
 * (approve/reject through the same gate endpoints); asks expose their options
 * (when the ask payload carried any) plus a free-text answer, delivered as a
 * directive to the asking session with the honest composer delivery states.
 * Items only turn final on the server's 200 / the authoritative stream event.
 *
 * Shared between the desktop Manage home and the mobile inbox tab.
 */
import { useState, type ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useConnectionStore, type AttentionItem } from '../stores/connection';

/** Inline approve/reject for a pending confirmation (exported for tests). */
export function ConfirmationActions({ item }: { item: AttentionItem }): ReactElement | null {
  const { t } = useTranslation();
  const resolve = useConnectionStore((s) => s.resolveConfirmation);
  if (item.kind !== 'confirmation' || item.refId === undefined) return null;
  const id = item.refId;
  return (
    <span style={{ display: 'inline-flex', gap: 6 }}>
      <button
        type="button"
        className="tn-btn tn-btn--primary"
        disabled={item.resolving === true}
        onClick={() => void resolve(id, 'approve')}
      >
        {t('inbox.approve')}
      </button>
      <button
        type="button"
        className="tn-btn"
        disabled={item.resolving === true}
        onClick={() => void resolve(id, 'reject')}
      >
        {t('inbox.deny')}
      </button>
    </span>
  );
}

/** Inline ask answer — option buttons (if offered) + free-text fallback. */
export function AskActions({ item }: { item: AttentionItem }): ReactElement | null {
  const { t } = useTranslation();
  const answerAsk = useConnectionStore((s) => s.answerAsk);
  const [text, setText] = useState('');
  if (item.kind !== 'ask' || item.sessionId === undefined) return null;
  if (item.answerState !== undefined && item.answerState !== 'sending') {
    // Answer accepted — show the honest delivery state until ask.answered
    // (the authoritative event) clears the item.
    return <span className="tn-chip">{t(`composer.state.${item.answerState}`)}</span>;
  }
  const busy = item.resolving === true;
  return (
    <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
      {(item.options ?? []).map((option) => (
        <button
          key={option}
          type="button"
          className="tn-btn"
          disabled={busy}
          onClick={() => void answerAsk(item.key, option)}
        >
          {option}
        </button>
      ))}
      <input
        className="tn-input"
        style={{ width: 140, padding: '2px 6px', fontSize: 12 }}
        value={text}
        placeholder={t('attention.answerPlaceholder')}
        aria-label={t('attention.answerPlaceholder')}
        onChange={(e) => setText(e.target.value)}
        disabled={busy}
      />
      <button
        type="button"
        className="tn-btn tn-btn--primary"
        disabled={busy || text.trim() === ''}
        onClick={() => {
          void answerAsk(item.key, text.trim());
          setText('');
        }}
      >
        {t('attention.answerSend')}
      </button>
    </span>
  );
}

/** One attention row (exported for the static-markup render tests). */
export function AttentionRow({ item }: { item: AttentionItem }): ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <div
      className="tn-card"
      style={{
        display: 'flex',
        gap: 8,
        alignItems: 'center',
        flexWrap: 'wrap',
        width: '100%',
        padding: '8px 10px',
        margin: '4px 0',
      }}
    >
      <span className="tn-dot tn-dot--warn" />
      <span className="tn-chip">{t(`home.attention.kind.${item.kind}`)}</span>
      <button
        type="button"
        onClick={() => {
          if (item.sessionId) void navigate(`/session/${encodeURIComponent(item.sessionId)}`);
        }}
        style={{
          flex: 1,
          minWidth: 120,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          textAlign: 'left',
          background: 'none',
          border: 'none',
          color: 'inherit',
          font: 'inherit',
          cursor: item.sessionId ? 'pointer' : 'default',
          padding: 0,
        }}
      >
        {item.summary ?? item.sessionId ?? ''}
      </button>
      <span style={{ fontSize: 11, color: 'var(--tn-fg-faint)' }}>
        {new Date(item.ts).toLocaleTimeString()}
      </span>
      <ConfirmationActions item={item} />
      <AskActions item={item} />
      {item.errorCode !== undefined ? (
        <span style={{ fontSize: 12, color: 'var(--tn-danger)' }}>
          {t('inbox.resolveFailed', { code: item.errorCode })}
        </span>
      ) : null}
    </div>
  );
}

export function AttentionSection(): ReactElement {
  const { t } = useTranslation();
  const attention = useConnectionStore((s) => s.attention);
  return (
    <section className="tn-card" style={{ padding: 16 }}>
      <h2 style={{ margin: '0 0 4px', fontSize: 16 }}>{t('home.attention.title')}</h2>
      <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--tn-fg-faint)' }}>
        {t('home.attention.sinceConnect')}
      </p>
      {attention.length === 0 ? (
        <div style={{ color: 'var(--tn-fg-muted)' }}>{t('home.attention.empty')}</div>
      ) : (
        attention.map((a) => <AttentionRow key={a.key} item={a} />)
      )}
    </section>
  );
}
