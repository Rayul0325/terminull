/**
 * CodeBlock — the shared preformatted-output primitive. Renders `pre.tn-code`
 * with a hard character cap (default 4000) and a bounded scroll height (default
 * 320px) so a runaway tool result can never blow out the transcript. Truncation
 * is shown explicitly with an ellipsis marker — honest by construction, never a
 * silent cut. `tone="error"` tints the block with the error wash.
 */
import type { CSSProperties, ReactElement } from 'react';

interface CodeBlockProps {
  text: string;
  language?: string;
  /** Max characters kept before truncation (default 4000). */
  cap?: number;
  /** Max rendered height in px before vertical scroll (default 320). */
  maxHeight?: number;
  tone?: 'error';
}

export function CodeBlock({
  text,
  language,
  cap = 4000,
  maxHeight = 320,
  tone,
}: CodeBlockProps): ReactElement {
  const source = typeof text === 'string' ? text : String(text ?? '');
  const capped = source.length > cap;
  const shown = capped ? source.slice(0, cap) : source;

  const style: CSSProperties = {
    margin: 0,
    maxHeight,
    overflow: 'auto',
    ...(tone === 'error'
      ? { color: 'var(--tn-err)', background: 'var(--tn-err-wash)' }
      : {}),
  };

  return (
    <pre className="tn-code" data-language={language} style={style}>
      {shown}
      {/* Language-neutral truncation marker: content exists beyond the cap. */}
      {capped ? '\n…' : ''}
    </pre>
  );
}
