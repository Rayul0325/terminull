/**
 * Manage home (/) — the Toss-style single-glance surface: status strip,
 * "지금 확인이 필요한 일" attention list, and the fleet board grouped by
 * project. The attention list mirrors stream events since connect — pre-
 * connect backlog needs a server projection endpoint (follow-up), and the
 * section says so instead of implying completeness. The supervisor chat and
 * new-session stepper are later M6 packets — not faked here.
 */
import type { ReactElement } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { groupByProject, projectIdOf, useFleetStore } from '../stores/fleet';
import { useConnectionStore } from '../stores/connection';

function StatusStrip(): ReactElement {
  const { t } = useTranslation();
  const wsStatus = useConnectionStore((s) => s.wsStatus);
  const hostConnected = useConnectionStore((s) => s.hostConnected);
  const seq = useConnectionStore((s) => s.seq);
  const wsDot =
    wsStatus === 'online'
      ? 'tn-dot--live'
      : wsStatus === 'offline'
        ? 'tn-dot--down'
        : 'tn-dot--warn';
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <span className="tn-chip">
        <span className={`tn-dot ${wsDot}`} />
        {t(`conn.ws.${wsStatus}`)}
      </span>
      <span className="tn-chip">
        <span
          className={`tn-dot ${
            hostConnected === null ? '' : hostConnected ? 'tn-dot--live' : 'tn-dot--down'
          }`}
        />
        {hostConnected === null
          ? t('conn.host.unknown')
          : hostConnected
            ? t('conn.host.up')
            : t('conn.host.down')}
      </span>
      <span className="tn-chip">{t('conn.seq', { seq })}</span>
    </div>
  );
}

function AttentionSection(): ReactElement {
  const { t } = useTranslation();
  const attention = useConnectionStore((s) => s.attention);
  const navigate = useNavigate();
  return (
    <section className="tn-card" style={{ padding: 16 }}>
      <h2 style={{ margin: '0 0 4px', fontSize: 16 }}>{t('home.attention.title')}</h2>
      <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--tn-fg-faint)' }}>
        {t('home.attention.sinceConnect')}
      </p>
      {attention.length === 0 ? (
        <div style={{ color: 'var(--tn-fg-muted)' }}>{t('home.attention.empty')}</div>
      ) : (
        attention.map((a) => (
          <button
            key={a.key}
            type="button"
            className="tn-card"
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              width: '100%',
              textAlign: 'left',
              padding: '8px 10px',
              margin: '4px 0',
              cursor: a.sessionId ? 'pointer' : 'default',
            }}
            onClick={() => {
              if (a.sessionId) void navigate(`/session/${encodeURIComponent(a.sessionId)}`);
            }}
          >
            <span className="tn-dot tn-dot--warn" />
            <span className="tn-chip">{t(`home.attention.kind.${a.kind}`)}</span>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {a.summary ?? a.sessionId ?? ''}
            </span>
            <span style={{ fontSize: 11, color: 'var(--tn-fg-faint)' }}>
              {new Date(a.ts).toLocaleTimeString()}
            </span>
          </button>
        ))
      )}
    </section>
  );
}

export function ManageHome(): ReactElement {
  const { t } = useTranslation();
  const snapshot = useFleetStore((s) => s.snapshot);
  const errorCode = useFleetStore((s) => s.errorCode);
  const groups = snapshot ? [...groupByProject(snapshot.sessions).entries()] : [];
  const brokenAdapters = snapshot?.adapters.filter((a) => !a.ok) ?? [];

  return (
    <div style={{ maxWidth: 1080, margin: '0 auto', padding: 16, display: 'grid', gap: 12 }}>
      <StatusStrip />
      <AttentionSection />
      <section className="tn-card" style={{ padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <h2 style={{ margin: '0 0 8px', fontSize: 16 }}>{t('home.fleet.title')}</h2>
          {snapshot ? (
            <span style={{ fontSize: 12, color: 'var(--tn-fg-faint)' }}>
              {t('home.fleet.generatedAt', {
                time: new Date(snapshot.generatedAt).toLocaleTimeString(),
              })}
            </span>
          ) : null}
          <span style={{ flex: 1 }} />
          <Link to="/workspace/all" className="tn-btn">
            {t('home.fleet.openWorkspace')}
          </Link>
        </div>
        {errorCode !== null ? (
          <div style={{ color: 'var(--tn-danger)' }}>
            {t('fleet.loadFailed', { code: errorCode })}
          </div>
        ) : null}
        {brokenAdapters.length > 0 ? (
          <div style={{ color: 'var(--tn-warn)', fontSize: 12 }}>
            {t('fleet.collectorFailed', {
              adapters: brokenAdapters.map((a) => a.adapterId).join(', '),
            })}
          </div>
        ) : null}
        {!snapshot && errorCode === null ? (
          <div style={{ color: 'var(--tn-fg-muted)' }}>{t('common.loading')}</div>
        ) : null}
        {snapshot && groups.length === 0 ? (
          <div style={{ color: 'var(--tn-fg-muted)' }}>{t('fleet.empty')}</div>
        ) : null}
        {groups.map(([cwd, sessions]) => (
          <div key={cwd || 'unknown'} style={{ margin: '10px 0' }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
              <Link
                to={`/workspace/${projectIdOf(cwd || undefined)}`}
                style={{ fontWeight: 600, color: 'var(--tn-fg)', textDecoration: 'none' }}
              >
                {cwd || t('home.fleet.unknownProject')}
              </Link>
              <span className="tn-chip">
                {t('home.fleet.sessionCount', { count: sessions.length })}
              </span>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {sessions.slice(0, 12).map((s) => (
                <Link
                  key={s.id}
                  to={`/session/${encodeURIComponent(s.id)}`}
                  className="tn-chip"
                  style={{ textDecoration: 'none', maxWidth: 280 }}
                  title={s.title ?? s.id}
                >
                  <span className={`tn-dot ${s.live ? 'tn-dot--live' : ''}`} />
                  <span
                    style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {s.title ?? s.id}
                  </span>
                </Link>
              ))}
              {sessions.length > 12 ? (
                <span className="tn-chip">
                  {t('home.fleet.more', { count: sessions.length - 12 })}
                </span>
              ) : null}
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
