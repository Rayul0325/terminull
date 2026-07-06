/**
 * Tool usage/account section — per-window usedPercent bars with HONEST
 * freshness labeling: `stale-turn-gated` gauges (codex) carry the "턴 실행
 * 시에만 갱신" caption plus the asOf timestamp instead of implying live data.
 * Unsupported tools (422) and available:false gauges render their machine
 * code / adapter reason — never an empty green gauge.
 */
import { useEffect, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { UsageWindowDto } from '@terminull/shared';
import { useToolUsageStore, type ToolUsageEntry } from '../stores/toolUsage';
import { pickLocalized } from './localized';

/** Tools whose usage endpoint the panel surfaces (codex is the M7 target). */
const USAGE_TOOL_IDS = ['codex'] as const;

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function WindowBar({ window: w }: { window: UsageWindowDto }): ReactElement {
  const { t } = useTranslation();
  const pct = clampPercent(w.usedPercent);
  const barColor =
    pct >= 90 ? 'var(--tn-danger)' : pct >= 75 ? 'var(--tn-warn)' : 'var(--tn-accent)';
  return (
    <div style={{ margin: '6px 0' }}>
      <div style={{ display: 'flex', gap: 8, fontSize: 12, alignItems: 'baseline' }}>
        <span style={{ fontFamily: 'var(--tn-font-mono)' }}>{w.label}</span>
        <span style={{ color: 'var(--tn-fg-muted)' }}>
          {t('usage.usedPercent', { percent: Math.round(pct) })}
        </span>
        <span style={{ flex: 1 }} />
        {w.resetsAt !== undefined ? (
          <span style={{ color: 'var(--tn-fg-faint)' }}>
            {t('usage.resets', { time: new Date(w.resetsAt).toLocaleString() })}
          </span>
        ) : null}
      </div>
      <div
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={w.label}
        style={{
          height: 8,
          borderRadius: 999,
          background: 'var(--tn-bg-sunken)',
          overflow: 'hidden',
        }}
      >
        <div style={{ width: `${pct}%`, height: '100%', background: barColor }} />
      </div>
    </div>
  );
}

function UsageGaugeCard({ entry }: { entry: ToolUsageEntry }): ReactElement {
  const { t, i18n } = useTranslation();
  const gauge = entry.gauge;
  const whoami = entry.account?.whoami;

  return (
    <div className="tn-card" style={{ padding: '10px 12px', margin: '6px 0' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600 }}>{entry.toolId}</span>
        {whoami?.available === true ? (
          <span className="tn-chip">{t('usage.account', { account: whoami.value.account })}</span>
        ) : null}
        {whoami?.available === true && whoami.value.plan !== undefined ? (
          <span className="tn-chip">{whoami.value.plan}</span>
        ) : null}
        <span style={{ flex: 1 }} />
        {gauge?.freshness === 'stale-turn-gated' ? (
          // Honest data-age label: this source only updates when a turn runs.
          <span className="tn-chip" style={{ color: 'var(--tn-warn)' }}>
            {t('usage.staleTurnGated')}
          </span>
        ) : null}
      </div>
      {entry.loading && gauge === null ? (
        <div style={{ color: 'var(--tn-fg-muted)', fontSize: 13 }}>{t('common.loading')}</div>
      ) : null}
      {entry.supported === false ? (
        <div style={{ color: 'var(--tn-fg-muted)', fontSize: 13 }}>
          {t('usage.unsupported', { code: entry.errorCode ?? '' })}
        </div>
      ) : null}
      {entry.supported !== false && entry.errorCode !== null ? (
        <div style={{ color: 'var(--tn-danger)', fontSize: 13 }}>
          {t('usage.loadFailed', { code: entry.errorCode })}
        </div>
      ) : null}
      {gauge !== null && !gauge.available ? (
        <div style={{ color: 'var(--tn-fg-muted)', fontSize: 13 }}>
          {t('usage.unavailable')}
          {gauge.reason !== undefined ? (
            <span style={{ marginLeft: 6 }}>{pickLocalized(gauge.reason, i18n.language)}</span>
          ) : null}
        </div>
      ) : null}
      {gauge !== null && gauge.available && gauge.windows.length === 0 ? (
        <div style={{ color: 'var(--tn-fg-muted)', fontSize: 13 }}>{t('usage.empty')}</div>
      ) : null}
      {gauge !== null && gauge.available
        ? gauge.windows.map((w, i) => (
            <WindowBar key={`${w.slot ?? ''}:${w.label}:${i}`} window={w} />
          ))
        : null}
      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        {gauge?.note !== undefined ? (
          <span style={{ fontSize: 12, color: 'var(--tn-fg-faint)' }}>
            {pickLocalized(gauge.note, i18n.language)}
          </span>
        ) : null}
        <span style={{ flex: 1 }} />
        {gauge?.asOf !== undefined ? (
          <span style={{ fontSize: 12, color: 'var(--tn-fg-faint)' }}>
            {t('usage.asOf', { time: new Date(gauge.asOf).toLocaleString() })}
          </span>
        ) : null}
      </div>
    </div>
  );
}

export function ToolUsageSection(): ReactElement {
  const { t } = useTranslation();
  const entries = useToolUsageStore((s) => s.entries);
  const load = useToolUsageStore((s) => s.load);

  useEffect(() => {
    for (const toolId of USAGE_TOOL_IDS) void load(toolId);
  }, [load]);

  return (
    <section className="tn-card" style={{ padding: 16 }}>
      <h2 style={{ margin: '0 0 8px', fontSize: 16 }}>{t('usage.title')}</h2>
      {USAGE_TOOL_IDS.map((toolId) => {
        const entry = entries[toolId];
        return entry !== undefined ? <UsageGaugeCard key={toolId} entry={entry} /> : null;
      })}
    </section>
  );
}
