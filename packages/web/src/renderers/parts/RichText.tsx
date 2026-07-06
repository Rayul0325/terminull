/**
 * RichText — a deliberately SMALL, XSS-safe markdown subset for chat-bubble
 * prose. Ported from the control-tower cockpit (public/js/app.js richText /
 * inlineMarks) and extended with links, headings and bullet lists.
 *
 * SECURITY CONTRACT (non-negotiable): every piece of the output is either a
 * React element built from a static tag, or an ESCAPED text node. There is NO
 * dangerouslySetInnerHTML anywhere in this file — user text can never become
 * live markup. Raw `<script>` in the input renders as the literal characters
 * `&lt;script&gt;`, links are whitelisted to http/https/relative only, and any
 * rejected URL scheme (javascript:, data:, vbscript:, …) falls back to plain
 * escaped text with no anchor and no href attribute.
 *
 * Supported subset:
 *   ```fenced```            → <CodeBlock>
 *   **bold**                → <b>
 *   `inline code`           → <code class="tn-inline-code">
 *   [text](http/https//)    → <a href rel="noopener noreferrer"> (whitelist only)
 *   "- " line-start         → <ul><li>
 *   #/##/### line-start     → <h4/h5/h6 class="tn-serif">
 */
import type { ReactElement, ReactNode } from 'react';
import { CodeBlock } from './CodeBlock';

/** Whitelist: only absolute http(s) URLs or root-relative paths are linkable. */
function isSafeUrl(url: string): boolean {
  return /^https?:\/\//i.test(url) || url.startsWith('/');
}

/**
 * Inline pass: split a single line into escaped text nodes + inline marks.
 * The regex matches, in one alternation, **bold**, `code`, and [text](url).
 * Everything between matches is pushed as a raw string → React escapes it.
 */
function inlineNodes(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\))/g;
  let last = 0;
  let i = 0;
  let m: RegExpExecArray | null = re.exec(text);
  while (m !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}-${i}`;
    i += 1;
    if (tok.startsWith('**')) {
      nodes.push(<b key={key}>{tok.slice(2, -2)}</b>);
    } else if (tok.startsWith('`')) {
      nodes.push(
        <code key={key} className="tn-inline-code">
          {tok.slice(1, -1)}
        </code>,
      );
    } else {
      const link = /^\[([^\]\n]+)\]\(([^)\s]+)\)$/.exec(tok);
      const label = link?.[1];
      const url = link?.[2];
      if (label && url && isSafeUrl(url)) {
        nodes.push(
          <a key={key} href={url} target="_blank" rel="noopener noreferrer">
            {label}
          </a>,
        );
      } else {
        // Rejected scheme (or malformed) → keep the literal text, escaped, no anchor.
        nodes.push(tok);
      }
    }
    last = m.index + tok.length;
    m = re.exec(text);
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

const HEADING_TAGS = ['h4', 'h5', 'h6'] as const;

/**
 * Block pass over one non-fenced prose segment: group `- ` bullets into a
 * <ul>, turn leading #/##/### into headings, and render every other non-blank
 * line as a paragraph. Each line's text goes through the inline pass.
 */
function blockNodes(segment: string, keyBase: string): ReactNode[] {
  const blocks: ReactNode[] = [];
  let bullets: ReactNode[] = [];

  const flushBullets = (): void => {
    if (bullets.length > 0) {
      blocks.push(
        <ul
          key={`${keyBase}-ul-${blocks.length}`}
          style={{ margin: '0.35em 0', paddingLeft: '1.2em' }}
        >
          {bullets}
        </ul>,
      );
      bullets = [];
    }
  };

  const lines = segment.split('\n');
  lines.forEach((line, idx) => {
    const bullet = /^-\s+(.*)$/.exec(line);
    if (bullet) {
      const body = bullet[1] ?? '';
      bullets.push(
        <li key={`${keyBase}-li-${idx}`}>{inlineNodes(body, `${keyBase}-li-${idx}`)}</li>,
      );
      return;
    }
    flushBullets();

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      const level = (heading[1] ?? '#').length;
      const body = heading[2] ?? '';
      const Tag = HEADING_TAGS[Math.min(level, 3) - 1] ?? 'h6';
      blocks.push(
        <Tag key={`${keyBase}-h-${idx}`} className="tn-serif" style={{ margin: '0.4em 0 0.2em' }}>
          {inlineNodes(body, `${keyBase}-h-${idx}`)}
        </Tag>,
      );
      return;
    }

    if (line.trim() === '') return; // blank line = spacer
    blocks.push(
      <p key={`${keyBase}-p-${idx}`} style={{ margin: '0.3em 0' }}>
        {inlineNodes(line, `${keyBase}-p-${idx}`)}
      </p>,
    );
  });
  flushBullets();
  return blocks;
}

export function RichText({ text }: { text: string }): ReactElement {
  const source = typeof text === 'string' ? text : String(text ?? '');
  // Split on fenced code fences (optional language + newline after the opening).
  const segments = source.split(/```(?:[a-zA-Z0-9_-]*\n)?/);
  const out: ReactNode[] = segments.map((seg, i) =>
    i % 2 === 1 ? (
      <CodeBlock key={`fence-${i}`} text={seg.replace(/\n$/, '')} />
    ) : (
      <div key={`block-${i}`}>{blockNodes(seg, `b${i}`)}</div>
    ),
  );
  return <div className="tn-richtext">{out}</div>;
}
