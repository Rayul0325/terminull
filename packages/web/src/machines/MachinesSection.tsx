/**
 * Settings › Machines — the registry machines with their live connection
 * state and last verified contact, plus the honest enrollment path: a
 * copyable CLI command. There is NO GUI enroll button on purpose (M8):
 * enrollment mutates a remote host over SSH, so it stays in the terminal
 * where the user's ssh agent and known_hosts live.
 */
import { useEffect, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { machineLabel, machineStateText } from './MachinesStrip';
import { machinesList, useMachinesStore } from '../stores/machines';

const ENROLL_COMMAND = 'terminull enroll <user@host> --label "<이름>"';

const STATE_DOT: Record<string, string> = {
  connected: 'tn-dot--live',
  connecting: 'tn-dot--warn',
  stale: 'tn-dot--down',
  disabled: '',
};

export function MachinesSection(): ReactElement {
  const { t } = useTranslation();
  const machines = useMachinesStore((s) => s.machines);
  const errorCode = useMachinesStore((s) => s.errorCode);
  const refresh = useMachinesStore((s) => s.refresh);
  const [copied, setCopied] = useState<'idle' | 'ok' | 'failed'>('idle');
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const list = machinesList(machines);

  const copyEnroll = (): void => {
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (clipboard === undefined) {
      setCopied('failed');
      return;
    }
    clipboard.writeText(ENROLL_COMMAND).then(
      () => {
        setCopied('ok');
        setTimeout(() => setCopied('idle'), 2000);
      },
      () => setCopied('failed'),
    );
  };

  return (
    <section className="tn-card" style={{ padding: 16 }}>
      <h2 style={{ margin: '0 0 8px', fontSize: 16 }}>{t('machines.settings.title')}</h2>
      {errorCode !== null ? (
        <div style={{ color: 'var(--tn-danger)', fontSize: 13 }}>
          {t('machines.settings.loadFailed', { code: errorCode })}
        </div>
      ) : null}
      {list.length === 0 && errorCode === null ? (
        <div style={{ color: 'var(--tn-fg-muted)', fontSize: 13 }}>
          {t('machines.settings.empty')}
        </div>
      ) : null}
      {list.map((m) => (
        <div
          key={m.id}
          style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0', fontSize: 13 }}
        >
          <span className={`tn-dot ${STATE_DOT[m.state] ?? ''}`} />
          <span style={{ fontWeight: 600 }}>{machineLabel(t, m.id, m)}</span>
          <code style={{ fontFamily: 'var(--tn-font-mono)', color: 'var(--tn-fg-faint)' }}>
            {m.id}
          </code>
          <span style={{ flex: 1 }} />
          <span
            className="tn-chip"
            style={{ color: m.state === 'stale' ? 'var(--tn-warn)' : undefined }}
          >
            {machineStateText(t, m, now)}
          </span>
          {m.lastSeenAt !== null ? (
            <span style={{ fontSize: 11, color: 'var(--tn-fg-faint)' }}>
              {new Date(m.lastSeenAt).toLocaleString()}
            </span>
          ) : null}
        </div>
      ))}
      <div style={{ marginTop: 12 }}>
        <h3 style={{ margin: '0 0 4px', fontSize: 13 }}>{t('machines.settings.enrollTitle')}</h3>
        <p style={{ margin: '0 0 6px', fontSize: 12, color: 'var(--tn-fg-muted)' }}>
          {t('machines.settings.enrollHint')}
        </p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <code
            style={{
              fontFamily: 'var(--tn-font-mono)',
              fontSize: 12,
              padding: '6px 10px',
              background: 'var(--tn-bg-sunken)',
              borderRadius: 6,
              userSelect: 'all',
            }}
          >
            {ENROLL_COMMAND}
          </code>
          <button type="button" className="tn-btn" onClick={copyEnroll}>
            {copied === 'ok'
              ? t('machines.settings.copied')
              : copied === 'failed'
                ? t('machines.settings.copyFailed')
                : t('machines.settings.copy')}
          </button>
        </div>
      </div>
    </section>
  );
}
