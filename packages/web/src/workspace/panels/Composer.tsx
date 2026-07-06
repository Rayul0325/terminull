/**
 * Composer v1 — draft + send through POST /api/directive with the optimistic
 * contract from the composer store: ⏳ sending → ✓ delivered / 대기열 queued /
 * 승인 대기 pending_confirmation / 실패 failed (draft restored). Slash-command
 * autocomplete and model/permission pickers are follow-up packets
 * (RENDERERS.md backlog) — no fake affordances here.
 */
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../components/Icon';
import { useComposerStore, type DirectiveSendState } from '../../stores/composer';

const STATE_KEY: Record<DirectiveSendState, string> = {
  sending: 'composer.state.sending',
  delivered: 'composer.state.delivered',
  queued: 'composer.state.queued',
  pending_confirmation: 'composer.state.pendingConfirmation',
  failed: 'composer.state.failed',
};

export function Composer({ sessionId }: { sessionId: string }): ReactElement {
  const { t } = useTranslation();
  const draft = useComposerStore((s) => s.drafts[sessionId] ?? '');
  const pending = useComposerStore((s) => s.pending);
  const setDraft = useComposerStore((s) => s.setDraft);
  const send = useComposerStore((s) => s.send);
  const dismiss = useComposerStore((s) => s.dismiss);
  const mine = pending.filter((p) => p.sessionId === sessionId).slice(-5);

  return (
    <div style={{ borderTop: '1px solid var(--tn-border)', padding: 8 }}>
      {mine.length > 0 ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
          {mine.map((p) => (
            <span
              key={p.localId}
              className="tn-chip"
              style={p.state === 'failed' ? { color: 'var(--tn-danger)' } : {}}
              title={p.text}
            >
              {t(STATE_KEY[p.state], { code: p.errorCode ?? '' })}
              <button
                type="button"
                onClick={() => dismiss(p.localId)}
                aria-label={t('common.dismiss')}
                style={{
                  display: 'inline-flex',
                  border: 'none',
                  background: 'none',
                  cursor: 'pointer',
                  color: 'inherit',
                  padding: 0,
                }}
              >
                <Icon name="close" size={11} strokeWidth={2} />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <form
        style={{ display: 'flex', gap: 6 }}
        onSubmit={(e) => {
          e.preventDefault();
          void send(sessionId);
        }}
      >
        <input
          className="tn-input"
          value={draft}
          onChange={(e) => setDraft(sessionId, e.target.value)}
          placeholder={t('composer.placeholder')}
          aria-label={t('composer.placeholder')}
        />
        <button type="submit" className="tn-btn tn-btn--primary" disabled={draft.trim() === ''}>
          {t('composer.send')}
        </button>
      </form>
    </div>
  );
}
