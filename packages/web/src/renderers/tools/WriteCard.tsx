/**
 * Seed renderer #3 — Write tool card. Shows the target path + size, and the
 * 상세보기 button opening the FULL content in the session side panel via
 * `ctx.openDetail` (the DetailView contract in registry.ts). Markdown files
 * request the 'markdown' detail kind — the side panel renders plain text
 * until the markdown-detail packet lands (honest label, no fake preview).
 */
import type { ReactElement } from 'react';
import type { RendererProps } from '../registry';

function inputOf(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') {
    const input = (raw as Record<string, unknown>)['input'];
    if (input && typeof input === 'object') return input as Record<string, unknown>;
  }
  return {};
}

export function WriteCard({ item, ctx }: RendererProps): ReactElement {
  const input = inputOf(item.raw);
  const path = typeof input['file_path'] === 'string' ? (input['file_path'] as string) : '';
  const content = typeof input['content'] === 'string' ? (input['content'] as string) : '';
  const isMarkdown = path.endsWith('.md') || path.endsWith('.markdown');

  return (
    <div className="tn-card" style={{ padding: '8px 12px', margin: '4px 0' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="tn-chip">{ctx.t('chat.tool.write')}</span>
        <code style={{ fontFamily: 'var(--tn-font-mono)', fontSize: 12 }}>{path}</code>
        <span style={{ color: 'var(--tn-fg-faint)', fontSize: 12 }}>
          {ctx.t('chat.tool.writeSize', { count: content.length })}
        </span>
        <span style={{ flex: 1 }} />
        {content.length > 0 ? (
          <button
            type="button"
            className="tn-btn"
            style={{ padding: '2px 8px', fontSize: 12 }}
            onClick={() =>
              ctx.openDetail({
                id: `write:${item.id}`,
                title: path,
                content: isMarkdown
                  ? { kind: 'markdown', value: content }
                  : { kind: 'text', value: content },
              })
            }
          >
            {ctx.t('chat.tool.detail')}
          </button>
        ) : (
          <span style={{ color: 'var(--tn-fg-faint)', fontSize: 12 }}>
            {ctx.t('chat.tool.contentUnavailable')}
          </span>
        )}
      </div>
    </div>
  );
}
