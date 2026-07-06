/**
 * Harness editor (M9 W2) — manifest-grouped file list (Korean labels from the
 * adapter's LocalizedText, risk badges, the read-only '내 커스텀' detection
 * group), and the per-file editor: guided/raw toggle (guided only where the
 * contract specs a form — none in v1), client-side diff preview, save with the
 * `expectedSha` optimistic lock, a 409 conflict sheet, 422 parse errors shown
 * VERBATIM, danger warning chrome + explicit confirm for high-risk files, and
 * the backups list with an undoable restore.
 */
import { useEffect, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { CustomHarnessGroupDto, HarnessFileDto } from '@terminull/shared';
import { pickLocalized } from '../agent/localized';
import { Sheet } from '../components/Sheet';
import { useHarnessStore, type SaveOutcome } from '../stores/harness';
import { guidedFormFor } from './guidedForms';
import { diffStats, lineDiff } from './lineDiff';

/** Risk badge — reuses the agent risk vocabulary (exported for tests). */
export function RiskBadge({ risk }: { risk: HarnessFileDto['riskLevel'] }): ReactElement {
  const { t } = useTranslation();
  const color =
    risk === 'high' ? 'var(--tn-danger)' : risk === 'med' ? 'var(--tn-warn)' : 'var(--tn-fg-faint)';
  return (
    <span className="tn-chip" style={{ color }}>
      {t(`settings.agent.risk.${risk}`)}
    </span>
  );
}

/** Save outcome note — 409/422/saved states (exported for tests). */
export function SaveOutcomeNote({ outcome }: { outcome: SaveOutcome | null }): ReactElement | null {
  const { t } = useTranslation();
  if (outcome === null) return null;
  switch (outcome.kind) {
    case 'saved':
      return (
        <div style={{ fontSize: 12, color: 'var(--tn-ok)' }}>
          {t('harness.saved')}{' '}
          <span style={{ color: 'var(--tn-fg-muted)' }}>
            {t(`harness.validation.${outcome.validation}`)}
          </span>
        </div>
      );
    case 'parse_invalid':
      // The parser's message VERBATIM — the user fixes exactly what it says.
      return (
        <div style={{ fontSize: 12, color: 'var(--tn-danger)' }}>
          <div>
            {t('harness.parseError', { format: outcome.format })}
            {outcome.line !== undefined ? (
              <span style={{ marginLeft: 6 }}>
                {t('harness.parseErrorLine', { line: outcome.line })}
              </span>
            ) : null}
          </div>
          <pre
            style={{
              margin: '4px 0 0',
              fontFamily: 'var(--tn-font-mono)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
            }}
          >
            {outcome.detail}
          </pre>
        </div>
      );
    case 'conflict':
      // The conflict SHEET drives resolution; this row is the inline residue.
      return (
        <div style={{ fontSize: 12, color: 'var(--tn-warn)' }}>
          {t('harness.error.sha_mismatch')}
        </div>
      );
    case 'error':
      return (
        <div style={{ fontSize: 12, color: 'var(--tn-danger)' }}>
          {t('harness.saveFailed', { code: t(`harness.error.${outcome.code}`, outcome.code) })}
        </div>
      );
  }
}

/** Diff preview rows (+/− prefixed, capped for the preview pane). */
function DiffPreview({ before, after }: { before: string; after: string }): ReactElement {
  const { t } = useTranslation();
  const rows = lineDiff(before, after);
  const changed = rows.filter((r) => r.type !== 'same');
  const stats = diffStats(rows);
  if (rows.length === 0) {
    return <div style={{ fontSize: 12, color: 'var(--tn-fg-muted)' }}>{t('harness.diff.none')}</div>;
  }
  return (
    <div style={{ fontSize: 12 }}>
      <div style={{ color: 'var(--tn-fg-muted)', marginBottom: 4 }}>
        {t('harness.diff.title')}{' '}
        <code style={{ fontFamily: 'var(--tn-font-mono)' }}>
          +{stats.added} −{stats.removed}
        </code>
      </div>
      <pre
        style={{
          margin: 0,
          maxHeight: 220,
          overflow: 'auto',
          fontFamily: 'var(--tn-font-mono)',
          background: 'var(--tn-bg-sunken)',
          padding: 8,
          borderRadius: 6,
        }}
      >
        {changed.map((row, i) => (
          <div
            key={i}
            style={{ color: row.type === 'add' ? 'var(--tn-ok)' : 'var(--tn-danger)' }}
          >
            {(row.type === 'add' ? '+ ' : '− ') + row.text}
          </div>
        ))}
      </pre>
    </div>
  );
}

/** '내 커스텀' — read-only detection results (exported for tests). */
export function CustomGroupCard({ group }: { group: CustomHarnessGroupDto }): ReactElement {
  const { t } = useTranslation();
  return (
    <div className="tn-card" style={{ padding: '10px 12px', margin: '6px 0' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600 }}>{t('harness.customGroup')}</span>
        <span className="tn-chip">{t('harness.customReadOnly')}</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: 'var(--tn-fg-faint)' }}>
          {t('harness.customScannedAt', {
            time: new Date(group.scannedAt).toLocaleTimeString(),
          })}
        </span>
      </div>
      {group.truncated ? (
        <div style={{ fontSize: 12, color: 'var(--tn-warn)' }}>{t('harness.customTruncated')}</div>
      ) : null}
      {group.items.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--tn-fg-muted)' }}>{t('harness.customEmpty')}</div>
      ) : (
        group.items.map((item, i) => (
          <div
            key={`${item.path}:${i}`}
            style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '3px 0' }}
          >
            <span className="tn-chip">{t(`harness.kind.${item.kind}`, item.kind)}</span>
            <span style={{ fontSize: 13 }}>{item.label ?? ''}</span>
            {item.detail !== undefined ? (
              <code style={{ fontSize: 11, fontFamily: 'var(--tn-font-mono)' }}>{item.detail}</code>
            ) : null}
            <span style={{ flex: 1 }} />
            <code
              style={{
                fontSize: 11,
                color: 'var(--tn-fg-faint)',
                fontFamily: 'var(--tn-font-mono)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                maxWidth: 260,
              }}
              title={item.path}
            >
              {item.path}
            </code>
          </div>
        ))
      )}
    </div>
  );
}

/** Per-file editor (exported for tests). */
export function HarnessFileEditor({ spec }: { spec: HarnessFileDto }): ReactElement {
  const { t, i18n } = useTranslation();
  const entry = useHarnessStore((s) => s.files[spec.id]);
  const open = useHarnessStore((s) => s.open);
  const setDraft = useHarnessStore((s) => s.setDraft);
  const save = useHarnessStore((s) => s.save);
  const loadBackups = useHarnessStore((s) => s.loadBackups);
  const restore = useHarnessStore((s) => s.restore);
  const [mode, setMode] = useState<'raw' | 'guided'>('raw');
  const [confirmSave, setConfirmSave] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState<string | null>(null);

  useEffect(() => {
    void open(spec.id);
    void loadBackups(spec.id);
  }, [spec.id, open, loadBackups]);

  const Guided = guidedFormFor(spec.id);
  const danger = spec.riskLevel === 'high';
  const read = entry?.read ?? null;
  const draft = entry?.draft ?? '';
  const dirty = read !== null && draft !== (read.content ?? '');
  const conflict = entry?.outcome?.kind === 'conflict' ? entry.outcome : null;

  const doSave = (): void => {
    setConfirmSave(false);
    void save(spec.id);
  };

  return (
    <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600 }}>{pickLocalized(spec.label, i18n.language)}</span>
        <RiskBadge risk={spec.riskLevel} />
        {read !== null && !read.exists ? (
          <span className="tn-chip">{t('harness.missing')}</span>
        ) : null}
        <span style={{ flex: 1 }} />
        {Guided !== undefined ? (
          // The guided/raw toggle exists ONLY when a contract-specced form does.
          <span style={{ display: 'inline-flex', gap: 4 }}>
            <button
              type="button"
              className="tn-btn"
              disabled={mode === 'guided'}
              onClick={() => setMode('guided')}
            >
              {t('harness.editor.guided')}
            </button>
            <button
              type="button"
              className="tn-btn"
              disabled={mode === 'raw'}
              onClick={() => setMode('raw')}
            >
              {t('harness.editor.raw')}
            </button>
          </span>
        ) : null}
      </div>
      {read?.path !== undefined ? (
        <code style={{ fontSize: 11, color: 'var(--tn-fg-faint)', fontFamily: 'var(--tn-font-mono)' }}>
          {read.path}
        </code>
      ) : null}
      {danger ? (
        // Warning chrome for danger files — mirrors the server-side confirm floor.
        <div
          style={{
            fontSize: 12,
            color: 'var(--tn-danger)',
            border: '1px solid var(--tn-danger)',
            borderRadius: 6,
            padding: '6px 8px',
          }}
        >
          {t('harness.editor.dangerNote')}
        </div>
      ) : null}
      {entry?.readErrorCode != null ? (
        <div style={{ fontSize: 12, color: 'var(--tn-danger)' }}>
          {t('harness.editor.readFailed', {
            code: t(`harness.error.${entry.readErrorCode}`, entry.readErrorCode),
          })}
        </div>
      ) : null}
      {entry?.loading === true ? (
        <div style={{ fontSize: 12, color: 'var(--tn-fg-muted)' }}>{t('common.loading')}</div>
      ) : null}
      {read !== null ? (
        <>
          {Guided !== undefined && mode === 'guided' ? (
            <Guided fileId={spec.id} draft={draft} onChange={(next) => setDraft(spec.id, next)} />
          ) : (
            <textarea
              className="tn-input"
              style={{
                fontFamily: 'var(--tn-font-mono)',
                fontSize: 12,
                minHeight: 200,
                whiteSpace: 'pre',
                resize: 'vertical',
              }}
              value={draft}
              onChange={(e) => setDraft(spec.id, e.target.value)}
              aria-label={pickLocalized(spec.label, i18n.language)}
            />
          )}
          <DiffPreview before={read.content ?? ''} after={draft} />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              type="button"
              className="tn-btn tn-btn--primary"
              disabled={!dirty || entry?.saving === true}
              onClick={() => {
                if (danger) setConfirmSave(true);
                else doSave();
              }}
            >
              {entry?.saving === true ? t('harness.saving') : t('harness.save')}
            </button>
            <SaveOutcomeNote outcome={entry?.outcome ?? null} />
          </div>
        </>
      ) : null}

      <details
        onToggle={(e) => {
          if ((e.target as HTMLDetailsElement).open) void loadBackups(spec.id);
        }}
      >
        <summary style={{ fontSize: 13, cursor: 'pointer', color: 'var(--tn-fg-muted)' }}>
          {t('harness.backups.title')}
        </summary>
        {entry?.backupsErrorCode != null ? (
          <div style={{ fontSize: 12, color: 'var(--tn-danger)' }}>
            {t('harness.backups.loadFailed', { code: entry.backupsErrorCode })}
          </div>
        ) : null}
        {entry?.backups !== null && entry?.backups !== undefined ? (
          entry.backups.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--tn-fg-muted)' }}>
              {t('harness.backups.empty')}
            </div>
          ) : (
            entry.backups.map((b) => (
              <div
                key={b.backupId}
                style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '3px 0' }}
              >
                <span style={{ fontSize: 12 }}>{new Date(b.ts).toLocaleString()}</span>
                <code style={{ fontSize: 11, fontFamily: 'var(--tn-font-mono)' }}>
                  {b.sha.slice(0, 12)}
                </code>
                <span style={{ fontSize: 11, color: 'var(--tn-fg-faint)' }}>
                  {t('harness.backups.bytes', { count: b.bytes })}
                </span>
                <span style={{ flex: 1 }} />
                <button
                  type="button"
                  className="tn-btn"
                  disabled={entry?.saving === true}
                  onClick={() => setConfirmRestore(b.backupId)}
                >
                  {t('harness.backups.restore')}
                </button>
              </div>
            ))
          )
        ) : null}
      </details>

      {/* Danger-save confirm sheet (client mirror of the server confirm floor). */}
      <Sheet open={confirmSave} title={t('harness.editor.dangerNote')} onClose={() => setConfirmSave(false)}>
        <div style={{ display: 'grid', gap: 8 }}>
          <DiffPreview before={read?.content ?? ''} after={draft} />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="tn-btn" onClick={() => setConfirmSave(false)}>
              {t('common.cancel')}
            </button>
            <button type="button" className="tn-btn tn-btn--primary" onClick={doSave}>
              {t('harness.saveDanger')}
            </button>
          </div>
        </div>
      </Sheet>

      {/* 409 conflict sheet — reload, then re-apply; the draft is never lost. */}
      <Sheet
        open={conflict !== null}
        title={t('harness.conflict.title')}
        onClose={() => void open(spec.id)}
      >
        <div style={{ display: 'grid', gap: 8 }}>
          <p style={{ margin: 0, fontSize: 13 }}>{t('harness.conflict.body')}</p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button
              type="button"
              className="tn-btn tn-btn--primary"
              onClick={() => void open(spec.id)}
            >
              {t('harness.conflict.reload')}
            </button>
          </div>
        </div>
      </Sheet>

      {/* Restore confirm — restore is undoable (current content backed up first). */}
      <Sheet
        open={confirmRestore !== null}
        title={t('harness.backups.restore')}
        onClose={() => setConfirmRestore(null)}
      >
        <div style={{ display: 'grid', gap: 8 }}>
          <p style={{ margin: 0, fontSize: 13 }}>{t('harness.backups.confirm')}</p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="tn-btn" onClick={() => setConfirmRestore(null)}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="tn-btn tn-btn--primary"
              onClick={() => {
                const backupId = confirmRestore;
                setConfirmRestore(null);
                if (backupId !== null) void restore(spec.id, backupId);
              }}
            >
              {t('harness.backups.restore')}
            </button>
          </div>
        </div>
      </Sheet>
    </div>
  );
}

/** One manifest file row (exported for tests). */
export function FileRow({
  spec,
  selected,
  onSelect,
}: {
  spec: HarnessFileDto;
  selected: boolean;
  onSelect(fileId: string | null): void;
}): ReactElement {
  const { t, i18n } = useTranslation();
  const editable = spec.directory !== true && spec.path !== undefined;
  return (
    <div style={{ padding: '2px 0' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button
          type="button"
          className="tn-btn"
          style={{ minWidth: 0, textAlign: 'left', flex: 1 }}
          disabled={!editable}
          onClick={() => onSelect(selected ? null : spec.id)}
        >
          {pickLocalized(spec.label, i18n.language)}
        </button>
        <RiskBadge risk={spec.riskLevel} />
        {spec.directory === true ? (
          <span className="tn-chip">{t('harness.directory')}</span>
        ) : spec.exists === false ? (
          <span className="tn-chip" style={{ color: 'var(--tn-fg-faint)' }}>
            {t('harness.missing')}
          </span>
        ) : null}
      </div>
      <div style={{ fontSize: 11, color: 'var(--tn-fg-faint)', padding: '0 2px' }}>
        {pickLocalized(spec.description, i18n.language)}
      </div>
      {selected ? <HarnessFileEditor spec={spec} /> : null}
    </div>
  );
}

export function HarnessSection(): ReactElement {
  const { t, i18n } = useTranslation();
  const groups = useHarnessStore((s) => s.groups);
  const errorCode = useHarnessStore((s) => s.errorCode);
  const custom = useHarnessStore((s) => s.custom);
  const customErrorCode = useHarnessStore((s) => s.customErrorCode);
  const loadManifest = useHarnessStore((s) => s.loadManifest);
  const loadCustom = useHarnessStore((s) => s.loadCustom);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    void loadManifest();
    void loadCustom();
  }, [loadManifest, loadCustom]);

  return (
    <section className="tn-card" style={{ padding: 16 }}>
      <h2 style={{ margin: '0 0 4px', fontSize: 16 }}>{t('harness.title')}</h2>
      <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--tn-fg-faint)' }}>
        {t('harness.subtitle')}
      </p>
      {errorCode !== null ? (
        <div style={{ color: 'var(--tn-danger)', fontSize: 13 }}>
          {t('harness.loadFailed', { code: errorCode })}
        </div>
      ) : null}
      {groups.map((group) => (
        <div key={group.toolId} className="tn-card" style={{ padding: '10px 12px', margin: '6px 0' }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            {pickLocalized(group.displayName, i18n.language)}
          </div>
          {group.files.map((spec) => (
            <FileRow key={spec.id} spec={spec} selected={selected === spec.id} onSelect={setSelected} />
          ))}
        </div>
      ))}
      {customErrorCode !== null ? (
        <div style={{ color: 'var(--tn-danger)', fontSize: 13 }}>
          {t('harness.customLoadFailed', { code: customErrorCode })}
        </div>
      ) : null}
      {custom !== null ? <CustomGroupCard group={custom} /> : null}
    </section>
  );
}
