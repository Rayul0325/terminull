/**
 * kind.system renderer — a system-channel notice.
 *
 * Fixes the duplicate-chip defect: the generic fallback rendered BOTH the role
 * label ("시스템") AND the kind label ("시스템") as two identical chips. Here a
 * system item shows exactly ONE chip, keyed on raw.subtype when the adapter
 * provided one (a machine subtype like "init"/"reminder"), else a single
 * localized "시스템" chip. The body text renders as bounded code; a leading raw
 * hook tag (<system-reminder>/<task-notification>) is replaced by a muted
 * "시스템 알림" chip instead of leaking the tag (defensive — the full parse is a
 * parser packet's job, out of scope here).
 */
import type { ReactElement } from 'react';
import { registerRenderer, type RendererProps } from '../registry';
import { Chip } from '../parts/Chip';
import { CodeBlock } from '../parts/CodeBlock';

const HOOK_TAG_RE = /^\s*<(system-reminder|task-notification)\b/;

/** Machine subtype off the raw payload, when the adapter emitted one. */
function subtypeOf(raw: unknown): string | undefined {
  if (raw && typeof raw === 'object') {
    const v = (raw as Record<string, unknown>)['subtype'];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

export function SystemView({ item, ctx }: RendererProps): ReactElement {
  const subtype = subtypeOf(item.raw);
  const label = subtype ?? ctx.t('chat.kind.system');
  const text = item.text ?? '';
  const isHookTag = HOOK_TAG_RE.test(text);
  return (
    <div className="tn-card" style={{ padding: '8px 12px', margin: '4px 0' }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        {/* Exactly ONE identity chip — never role+kind duplicated. */}
        <Chip>{label}</Chip>
        {isHookTag ? <Chip tone="idle">{ctx.t('chat.system.hookTag')}</Chip> : null}
      </div>
      {text.length > 0 && !isHookTag ? (
        <div style={{ marginTop: 6 }}>
          <CodeBlock text={text} />
        </div>
      ) : null}
    </div>
  );
}

registerRenderer({
  id: 'kind.system',
  match: { kind: 'system' },
  Component: SystemView,
});
