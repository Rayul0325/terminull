/**
 * Approval inbox — pending manage-agent proposals as cards (action glyph,
 * human label, target session, requested-at, masked params, brain rationale),
 * with 승인/거절 driving the contracted resolve endpoint. Buttons flip the card
 * into a resolving state only; the green/red outcome comes from the server's
 * 200 (or the confirmation.* stream event). Resolved cards keep their outcome
 * plus the received `agent.action` audit trail behind a disclosure.
 */
import { Fragment, useEffect, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { pendingApprovals, useApprovalsStore, type ApprovalEntry } from '../stores/approvals';

/** Non-emoji glyph per permission-action id (fallback: generic bullet). */
const ACTION_GLYPH: Record<string, string> = {
  'directive.send': '→',
  'session.spawn': '⊕',
  'ask.answer': '?',
  'plan.approve': '✓',
  'permission.mode': '⇄',
  'session.interrupt': '■',
  'board.edit': '▤',
};
const GLYPH_FALLBACK = '•';

/** Server action id ('session.spawn') → web label key ('perm.session_spawn'). */
function permLabelKey(action: string): string {
  return `perm.${action.replace(/\./g, '_')}`;
}

function OutcomeChip({ entry }: { entry: ApprovalEntry }): ReactElement | null {
  const { t } = useTranslation();
  switch (entry.state) {
    case 'approved':
      return (
        <span className="tn-chip" style={{ color: 'var(--tn-ok)' }}>
          {t('inbox.outcome.approved')}
        </span>
      );
    case 'rejected':
      return (
        <span className="tn-chip" style={{ color: 'var(--tn-danger)' }}>
          {t('inbox.outcome.rejected')}
        </span>
      );
    case 'gone':
      return (
        <span className="tn-chip" style={{ color: 'var(--tn-fg-faint)' }}>
          {t('inbox.outcome.gone')}
        </span>
      );
    default:
      return null;
  }
}

/** Render one masked param value verbatim (strings as-is, the rest as JSON). */
function paramValueText(value: unknown): string {
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
}

/**
 * Masked machine params of the proposed action — the concrete fields that will
 * run (cwd, cmd, …), so the user never approves blind on the action label
 * alone. Rendered verbatim: masking already happened server-side (maskDeep).
 * Absent or empty params render nothing.
 */
function ApprovalParams({ params }: { params: unknown }): ReactElement | null {
  const { t } = useTranslation();
  if (params === undefined || params === null) return null;
  const rows =
    typeof params === 'object' && !Array.isArray(params)
      ? Object.entries(params as Record<string, unknown>)
      : null;
  if (rows !== null && rows.length === 0) return null;
  return (
    <div style={{ fontSize: 12 }}>
      <span style={{ color: 'var(--tn-fg-muted)' }}>{t('inbox.params')}</span>
      {rows !== null ? (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'max-content minmax(0, 1fr)',
            gap: '2px 8px',
            marginTop: 2,
          }}
        >
          {rows.map(([key, value]) => (
            <Fragment key={key}>
              <span style={{ color: 'var(--tn-fg-faint)' }}>{key}</span>
              <code
                style={{
                  fontFamily: 'var(--tn-font-mono)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                }}
              >
                {paramValueText(value)}
              </code>
            </Fragment>
          ))}
        </div>
      ) : (
        <pre
          style={{
            margin: '2px 0 0',
            fontFamily: 'var(--tn-font-mono)',
            fontSize: 12,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          }}
        >
          {paramValueText(params)}
        </pre>
      )}
    </div>
  );
}

/** Exported for the static-markup render tests (no DOM test env here). */
export function ApprovalCard({ entry }: { entry: ApprovalEntry }): ReactElement {
  const { t } = useTranslation();
  const resolve = useApprovalsStore((s) => s.resolve);
  const { card } = entry;
  const actionable = entry.state === 'pending';
  const resolving = entry.state === 'resolving';

  return (
    <div
      id={`approval-${card.id}`}
      className="tn-card"
      style={{ padding: '10px 12px', margin: '6px 0' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span
          aria-hidden="true"
          style={{
            width: 26,
            height: 26,
            borderRadius: 'var(--tn-radius-sm)',
            background: 'var(--tn-chip-bg)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 14,
            flex: 'none',
          }}
        >
          {ACTION_GLYPH[card.action] ?? GLYPH_FALLBACK}
        </span>
        <span style={{ flex: 1, minWidth: 120, fontSize: 14 }}>
          {t(permLabelKey(card.action), { defaultValue: card.action })}
        </span>
        <span style={{ fontSize: 11, color: 'var(--tn-fg-faint)' }}>
          {t('inbox.requestedAt', { time: new Date(card.createdAt).toLocaleTimeString() })}
        </span>
        <OutcomeChip entry={entry} />
        {actionable || resolving ? (
          <span style={{ display: 'inline-flex', gap: 6 }}>
            <button
              type="button"
              className="tn-btn tn-btn--primary"
              disabled={resolving}
              onClick={() => void resolve(card.id, 'approve')}
            >
              {resolving && entry.decision === 'approve'
                ? t('inbox.resolving')
                : t('inbox.approve')}
            </button>
            <button
              type="button"
              className="tn-btn"
              disabled={resolving}
              onClick={() => void resolve(card.id, 'reject')}
            >
              {resolving && entry.decision === 'reject' ? t('inbox.resolving') : t('inbox.deny')}
            </button>
          </span>
        ) : null}
      </div>
      <div style={{ marginTop: 4, display: 'grid', gap: 2 }}>
        {card.sessionId !== undefined ? (
          <span style={{ fontSize: 12, color: 'var(--tn-fg-muted)' }}>
            {t('inbox.session', { id: card.sessionId })}
          </span>
        ) : null}
        <ApprovalParams params={card.params} />
        {card.origin?.reason !== undefined ? (
          // Brain-supplied rationale: display only, already masked server-side.
          <span style={{ fontSize: 12, color: 'var(--tn-fg-muted)' }}>
            {t('inbox.reason')}
            {': '}
            {card.origin.reason}
          </span>
        ) : null}
        {entry.errorCode !== undefined ? (
          <span style={{ fontSize: 12, color: 'var(--tn-danger)' }}>
            {t('inbox.resolveFailed', { code: entry.errorCode })}
          </span>
        ) : null}
      </div>
      {entry.state !== 'pending' && entry.state !== 'resolving' ? (
        <details style={{ marginTop: 6 }}>
          <summary style={{ fontSize: 12, color: 'var(--tn-fg-muted)', cursor: 'pointer' }}>
            {t('inbox.trail')}
          </summary>
          {entry.trail.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--tn-fg-faint)', padding: '4px 0' }}>
              {t('inbox.trailEmpty')}
            </div>
          ) : (
            <ol style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 12 }}>
              {entry.trail.map((step, i) => (
                <li key={i} style={{ color: 'var(--tn-fg-muted)' }}>
                  {t(`agent.phase.${step.phase}`, { defaultValue: step.phase })}
                  {step.resultCode !== undefined ? (
                    <code style={{ marginLeft: 6, fontFamily: 'var(--tn-font-mono)' }}>
                      {step.resultCode}
                    </code>
                  ) : null}
                  <span style={{ marginLeft: 6, color: 'var(--tn-fg-faint)' }}>
                    {new Date(step.ts).toLocaleTimeString()}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </details>
      ) : null}
    </div>
  );
}

export function ApprovalsInbox(): ReactElement {
  const { t } = useTranslation();
  const entries = useApprovalsStore((s) => s.entries);
  const errorCode = useApprovalsStore((s) => s.errorCode);
  const refresh = useApprovalsStore((s) => s.refresh);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const pending = pendingApprovals(entries);
  const resolved = entries.filter((e) => !pending.includes(e));

  return (
    <section className="tn-card" style={{ padding: 16 }}>
      <h2 style={{ margin: '0 0 4px', fontSize: 16 }}>{t('inbox.title')}</h2>
      <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--tn-fg-faint)' }}>
        {t('inbox.subtitle')}
      </p>
      {errorCode !== null ? (
        <div style={{ color: 'var(--tn-danger)', fontSize: 13 }}>
          {t('inbox.loadFailed', { code: errorCode })}
        </div>
      ) : null}
      {pending.length === 0 ? (
        <div style={{ color: 'var(--tn-fg-muted)' }}>{t('inbox.empty')}</div>
      ) : (
        pending.map((e) => <ApprovalCard key={e.card.id} entry={e} />)
      )}
      {resolved.map((e) => (
        <ApprovalCard key={e.card.id} entry={e} />
      ))}
    </section>
  );
}
