/**
 * RichText security + subset tests. Static markup via react-dom/server (no
 * jsdom, no i18n) — the honesty/XSS-critical assertions: marks render, safe
 * links become anchors, unsafe schemes are stripped to plain text, and raw
 * HTML in the input is escaped (never a live tag).
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RichText } from './RichText';

describe('RichText safe markdown subset', () => {
  it('renders **bold** as a <b> element', () => {
    const html = renderToStaticMarkup(<RichText text="a **bold** b" />);
    expect(html).toContain('<b>bold</b>');
  });

  it('renders `code` as inline code with the tn-inline-code class', () => {
    const html = renderToStaticMarkup(<RichText text="run `npm test` now" />);
    expect(html).toContain('tn-inline-code');
    expect(html).toContain('npm test');
  });

  it('renders a fenced block as a tn-code pre', () => {
    const html = renderToStaticMarkup(<RichText text={'intro\n```\nconst x = 1\n```\nend'} />);
    expect(html).toContain('tn-code');
    expect(html).toContain('const x = 1');
  });

  it('renders an http(s) link as an anchor with a safe rel', () => {
    const html = renderToStaticMarkup(<RichText text="see [docs](https://example.test/x)" />);
    expect(html).toContain('href="https://example.test/x"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('>docs</a>');
  });

  it('rejects a javascript: link — no anchor, no href attribute', () => {
    const html = renderToStaticMarkup(<RichText text="bad [x](javascript:alert(1))" />);
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('href=');
    expect(html).not.toContain('href="javascript:');
  });

  it('escapes raw HTML — a <script> in the input never becomes a live tag', () => {
    const html = renderToStaticMarkup(<RichText text={'hi <script>alert(1)</script>'} />);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
