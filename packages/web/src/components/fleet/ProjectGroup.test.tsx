/* eslint-disable i18next/no-literal-string -- test fixtures render literal strings on purpose */
/**
 * ProjectGroup render tests — the collapsible cwd-node header: name + session
 * count + a live dot only when a child is busy, children shown when open and
 * hidden when collapsed. Static markup via react-dom/server; ProjectGroup reads
 * no stores, so only i18n must be initialized.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '../../i18n';
import ko from '../../i18n/locales/ko.json';
import { ProjectGroup } from './ProjectGroup';

beforeAll(async () => {
  if (!i18n.isInitialized) {
    await new Promise<void>((resolve) => i18n.on('initialized', () => resolve()));
  }
});

describe('ProjectGroup', () => {
  it('renders the name, the localized count, and its children when open', () => {
    const html = renderToStaticMarkup(
      <ProjectGroup name="my-proj" count={3}>
        <div>child-row</div>
      </ProjectGroup>,
    );
    expect(html).toContain('my-proj');
    expect(html).toContain(ko.fleet.group.count.replace('{{count}}', '3'));
    expect(html).toContain('child-row');
  });

  it('hides children when collapsed (defaultOpen=false)', () => {
    const html = renderToStaticMarkup(
      <ProjectGroup name="my-proj" count={1} defaultOpen={false}>
        <div>child-row</div>
      </ProjectGroup>,
    );
    expect(html).not.toContain('child-row');
    // the header (name + count) still renders
    expect(html).toContain('my-proj');
  });

  it('shows a running dot only when a child is busy', () => {
    const busy = renderToStaticMarkup(
      <ProjectGroup name="p" count={1} anyBusy>
        <div>row</div>
      </ProjectGroup>,
    );
    expect(busy).toContain('tn-status-dot--running');
    const idle = renderToStaticMarkup(
      <ProjectGroup name="p" count={1}>
        <div>row</div>
      </ProjectGroup>,
    );
    expect(idle).not.toContain('tn-status-dot--running');
  });
});
