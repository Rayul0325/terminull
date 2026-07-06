/* eslint-disable i18next/no-literal-string -- test fixtures render literal strings on purpose */
/**
 * ToolCardShell render test. Static markup via react-dom/server (no jsdom) —
 * confirms the card frame renders the eyebrow label and its body children.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ToolCardShell } from './ToolCardShell';

describe('ToolCardShell', () => {
  it('renders the eyebrow and the body children inside a card', () => {
    const html = renderToStaticMarkup(
      <ToolCardShell icon="terminal" eyebrow="BASH">
        <span>body-content</span>
      </ToolCardShell>,
    );
    expect(html).toContain('tn-card');
    expect(html).toContain('tn-eyebrow');
    expect(html).toContain('BASH');
    expect(html).toContain('body-content');
  });
});
