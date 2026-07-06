/**
 * Edit tool card — target path plus an inline preview of the line diff
 * between `old_string` and `new_string` (reusing the harness's `lineDiff`
 * utility, the same alignment the M9 save-preview uses), and a "변경 보기"
 * affordance that opens the FULL diff in the session side panel via the
 * registry's 'diff' DetailView kind. Honest by construction: a missing path
 * or missing before/after string renders the explicit "확인 중" state —
 * never a fabricated path or diff.
 */
import type { ReactElement } from 'react';
import type { RendererProps } from '../registry';
import { registerRenderer } from '../registry';
import { Chip } from '../parts/Chip';
import { ToolCardShell } from '../parts/ToolCardShell';
import { diffStats, lineDiff, type DiffRow } from '../../harness/lineDiff';

function inputOf(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') {
    const input = (raw as Record<string, unknown>)['input'];
    if (input && typeof input === 'object') return input as Record<string, unknown>;
  }
  return {};
}

function strField(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key];
  return typeof v === 'string' ? v : undefined;
}

/** Inline preview cap — the "변경 보기" detail view carries the full diff. */
const PREVIEW_ROW_CAP = 40;

function DiffPreview({ rows }: { rows: DiffRow[] }): ReactElement {
  const shown = rows.slice(0, PREVIEW_ROW_CAP);
  return (
    <div
      style={{
        maxHeight: 220,
        overflow: 'auto',
        fontFamily: 'var(--tn-font-mono)',
        fontSize: 12,
        borderRadius: 'var(--tn-radius-sm)',
        border: '1px solid var(--tn-hair)',
      }}
    >
      {shown.map((row, i) => (
        <div
          key={i}
          style={{
            padding: '0 6px',
            whiteSpace: 'pre-wrap',
            background:
              row.type === 'add'
                ? 'var(--tn-ok-wash)'
                : row.type === 'del'
                  ? 'var(--tn-danger-wash)'
                  : 'transparent',
            color: row.type === 'same' ? 'var(--tn-fg-muted)' : 'var(--tn-fg)',
          }}
        >
          {row.type === 'add' ? '+ ' : row.type === 'del' ? '- ' : '  '}
          {row.text}
        </div>
      ))}
      {rows.length > PREVIEW_ROW_CAP ? (
        <div style={{ padding: '0 6px', color: 'var(--tn-fg-faint)' }}>…</div>
      ) : null}
    </div>
  );
}

export function EditCard({ item, ctx }: RendererProps): ReactElement {
  const input = inputOf(item.raw);
  const filePath = strField(input, 'file_path');
  const oldString = strField(input, 'old_string');
  const newString = strField(input, 'new_string');
  const hasInput = filePath !== undefined && oldString !== undefined && newString !== undefined;
  const rows = hasInput ? lineDiff(oldString ?? '', newString ?? '') : [];
  const stats = diffStats(rows);

  return (
    <ToolCardShell
      icon="edit"
      eyebrow={ctx.t('chat.toolLabel.Edit')}
      title={
        filePath !== undefined ? (
          <code className="tn-inline-code">{filePath}</code>
        ) : (
          ctx.t('chat.field.checking')
        )
      }
      badges={
        hasInput && rows.length > 0 ? (
          <>
            {stats.added > 0 ? <Chip tone="done">+{stats.added}</Chip> : null}
            {stats.removed > 0 ? <Chip tone="error">-{stats.removed}</Chip> : null}
          </>
        ) : null
      }
      right={
        hasInput ? (
          <button
            type="button"
            className="tn-btn"
            style={{ padding: '2px 8px', fontSize: 12 }}
            onClick={() =>
              ctx.openDetail({
                id: `edit:${item.id}`,
                title: filePath,
                content: {
                  kind: 'diff',
                  before: oldString ?? '',
                  after: newString ?? '',
                  path: filePath,
                },
              })
            }
          >
            {ctx.t('chat.edit.viewDiff')}
          </button>
        ) : null
      }
    >
      {!hasInput ? null : rows.length === 0 ? (
        <span style={{ color: 'var(--tn-fg-faint)', fontSize: 12 }}>
          {ctx.t('chat.edit.noChange')}
        </span>
      ) : (
        <DiffPreview rows={rows} />
      )}
    </ToolCardShell>
  );
}

registerRenderer({
  id: 'tool.edit',
  match: { kind: 'tool_call', toolName: 'Edit' },
  Component: EditCard,
});
