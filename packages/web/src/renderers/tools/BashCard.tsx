/**
 * Seed renderer #2 — Bash tool card. Shows the command + description from the
 * tool_use input, the PAIRED tool_result output when the parser emitted one
 * (gap-matrix P0 #1 pairing contract), and an honest "결과 미수신" state when
 * pairing data is absent. The 터미널 점프 affordance renders only where the
 * workspace provides `ctx.jumpToTerminal`.
 */
import { useState, type ReactElement } from 'react';
import type { RendererProps } from '../registry';

function inputField(raw: unknown, key: string): string {
  if (raw && typeof raw === 'object') {
    const input = (raw as Record<string, unknown>)['input'];
    if (input && typeof input === 'object') {
      const v = (input as Record<string, unknown>)[key];
      if (typeof v === 'string') return v;
    }
  }
  return '';
}

function resultInfo(paired: RendererProps['item'] | undefined): {
  state: 'ok' | 'error' | 'missing';
  text: string;
} {
  if (!paired) return { state: 'missing', text: '' };
  const raw = paired.raw;
  const isError =
    raw && typeof raw === 'object' && (raw as Record<string, unknown>)['isError'] === true;
  return { state: isError ? 'error' : 'ok', text: paired.text ?? '' };
}

const OUTPUT_CAP = 4000;

export function BashCard({ item, ctx }: RendererProps): ReactElement {
  const [open, setOpen] = useState(false);
  const command = inputField(item.raw, 'command');
  const description = inputField(item.raw, 'description');
  const result = resultInfo(ctx.pairedResult);

  return (
    <div className="tn-card" style={{ padding: '8px 12px', margin: '4px 0' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="tn-chip">{ctx.t('chat.tool.bash')}</span>
        {description ? (
          <span style={{ color: 'var(--tn-fg-muted)', fontSize: 12 }}>{description}</span>
        ) : null}
        <span style={{ flex: 1 }} />
        {ctx.jumpToTerminal ? (
          <button
            type="button"
            className="tn-btn"
            style={{ padding: '2px 8px', fontSize: 12 }}
            onClick={() => ctx.jumpToTerminal?.(ctx.sessionId)}
          >
            {ctx.t('chat.tool.openTerminal')}
          </button>
        ) : null}
      </div>
      <pre
        style={{
          margin: '6px 0 0',
          padding: '6px 8px',
          background: 'var(--tn-bg-sunken)',
          borderRadius: 'var(--tn-radius-sm)',
          whiteSpace: 'pre-wrap',
          fontFamily: 'var(--tn-font-mono)',
          fontSize: 12,
        }}
      >
        {command || (item.text ?? '')}
      </pre>
      {result.state === 'missing' ? (
        <div style={{ color: 'var(--tn-fg-faint)', fontSize: 12, marginTop: 4 }}>
          {ctx.t('chat.tool.resultMissing')}
        </div>
      ) : (
        <div style={{ marginTop: 4 }}>
          <button
            type="button"
            className="tn-btn"
            style={{ padding: '2px 8px', fontSize: 12 }}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? ctx.t('chat.tool.hideOutput') : ctx.t('chat.tool.showOutput')}
            {result.state === 'error' ? ` · ${ctx.t('chat.tool.resultError')}` : ''}
          </button>
          {open ? (
            <pre
              style={{
                margin: '6px 0 0',
                padding: '6px 8px',
                background: 'var(--tn-bg-sunken)',
                borderRadius: 'var(--tn-radius-sm)',
                whiteSpace: 'pre-wrap',
                fontFamily: 'var(--tn-font-mono)',
                fontSize: 12,
                ...(result.state === 'error' ? { color: 'var(--tn-danger)' } : {}),
                maxHeight: 320,
                overflow: 'auto',
              }}
            >
              {result.text.length > OUTPUT_CAP ? result.text.slice(0, OUTPUT_CAP) : result.text}
            </pre>
          ) : null}
        </div>
      )}
    </div>
  );
}
