/**
 * Chip + StatusDot — the two smallest shared primitives every renderer track
 * uses to signal a tool/session state. Both are pure presentational wrappers
 * over the P0 design-system classes (`.tn-badge*` / `.tn-status-dot*`); they
 * never carry state or invent a value, so a caller passing an honest tone is
 * the single source of truth for what the pill/dot means.
 */
import type { ReactElement, ReactNode } from 'react';

/** Badge tones — map 1:1 to `.tn-badge--<tone>` in tokens.css. */
export type ChipTone =
  'default' | 'running' | 'idle' | 'ask' | 'approval' | 'done' | 'error' | 'report';

interface ChipProps {
  tone?: ChipTone;
  children: ReactNode;
}

/**
 * A pill label. Renders `span.tn-badge.tn-badge--<tone>`; `default` falls back
 * to the base `.tn-badge` styling (no dedicated modifier rule, harmless class).
 */
export function Chip({ tone = 'default', children }: ChipProps): ReactElement {
  return <span className={`tn-badge tn-badge--${tone}`}>{children}</span>;
}

/** Status-dot tones — map 1:1 to `.tn-status-dot--<tone>` in tokens.css. */
export type StatusDotTone =
  'running' | 'idle' | 'asking' | 'approval' | 'done' | 'error' | 'offline';

interface StatusDotProps {
  tone: StatusDotTone;
}

/** An 8px state dot with a colored wash ring. Decorative (aria-hidden). */
export function StatusDot({ tone }: StatusDotProps): ReactElement {
  return <span className={`tn-status-dot tn-status-dot--${tone}`} aria-hidden="true" />;
}
