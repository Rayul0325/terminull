/**
 * The guaranteed fallback renderer — matches EVERYTHING (empty match). An
 * unknown tool, a future ChatItem kind, or a foreign adapter renders through
 * this instead of breaking the transcript. Honest by construction: it shows
 * role, kind, and whatever text exists; nothing is invented.
 *
 * Repainted onto the P0 design system: a `.tn-card` with Chip role/kind labels
 * (DEDUPED — when the resolved role label equals the resolved kind label, e.g.
 * "시스템"/"시스템", exactly ONE chip shows) and a bounded CodeBlock for text.
 * A leading hook tag (<system-reminder>/<task-notification>) renders a muted
 * "시스템 알림" chip instead of dumping the raw tag (defensive; the full parse
 * is a parser packet's job, out of scope here).
 */
import type { ReactElement } from 'react';
import type { RendererProps } from './registry';
import { toolNameOf } from './registry';
import { Chip } from './parts/Chip';
import { CodeBlock } from './parts/CodeBlock';

const TEXT_CAP = 2000;
const HOOK_TAG_RE = /^\s*<(system-reminder|task-notification)\b/;

export function GenericItem({ item, ctx }: RendererProps): ReactElement {
  const name = toolNameOf(item);
  const text = item.text ?? '';
  const roleLabel = ctx.t(`chat.role.${item.role}`, item.role);
  const kindLabel = ctx.t(`chat.kind.${item.kind}`, item.kind);
  // Dedupe: identical role/kind labels (e.g. system/system) collapse to one chip.
  const showKind = kindLabel !== roleLabel;
  const isHookTag = HOOK_TAG_RE.test(text);
  const hasText = text.length > 0 && !isHookTag;

  return (
    <div className="tn-card" style={{ padding: '8px 12px', margin: '4px 0' }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <Chip>{roleLabel}</Chip>
        {showKind ? <Chip>{kindLabel}</Chip> : null}
        {name !== undefined ? <Chip>{name}</Chip> : null}
        {isHookTag ? <Chip tone="idle">{ctx.t('chat.system.hookTag')}</Chip> : null}
      </div>
      {hasText ? (
        <div style={{ marginTop: 6 }}>
          <CodeBlock text={text} cap={TEXT_CAP} />
        </div>
      ) : text.length === 0 ? (
        <div style={{ color: 'var(--tn-fg-faint)', fontSize: 12, marginTop: 4 }}>
          {ctx.t('chat.generic.noText')}
        </div>
      ) : null}
    </div>
  );
}
