/**
 * Approval-card render tests: the card must surface the masked params — the
 * concrete fields the user is approving (contract §6: action label, masked
 * params, origin.reason) — never just the action label. No DOM test
 * environment in this package, so cards render to static markup
 * (react-dom/server); the approve-flow behaviour itself stays covered by the
 * store tests in ../stores/approvals.test.ts.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '../i18n';
import ko from '../i18n/locales/ko.json';
import type { ApprovalEntry } from '../stores/approvals';
import { ApprovalCard } from './ApprovalsInbox';

beforeAll(async () => {
  // The i18n module inits on import with bundled resources; only wait if that
  // init has not completed synchronously.
  if (!i18n.isInitialized) {
    await new Promise<void>((resolve) => i18n.on('initialized', () => resolve()));
  }
});

function entryWith(params: unknown): ApprovalEntry {
  return {
    card: {
      id: 'c-1',
      action: 'session.spawn',
      actor: 'agent',
      params,
      createdAt: 1111,
      origin: { kind: 'manage-agent', proposalId: 'p-1', turnId: 't-1', reason: 'need a worker' },
    },
    state: 'pending',
    trail: [],
  };
}

describe('ApprovalCard params rendering', () => {
  it('renders every masked param key and value, keeping approve/deny actionable', () => {
    const html = renderToStaticMarkup(
      <ApprovalCard
        entry={entryWith({ cwd: '/tmp/spawn-here', cmd: 'rm -rf build', retries: 42 })}
      />,
    );
    expect(html).toContain(ko.inbox.params);
    for (const text of ['cwd', '/tmp/spawn-here', 'cmd', 'rm -rf build', 'retries', '42']) {
      expect(html).toContain(text);
    }
    expect(html).toContain(ko.inbox.approve);
    expect(html).toContain(ko.inbox.deny);
  });

  it('renders non-object params as a mono block', () => {
    const html = renderToStaticMarkup(<ApprovalCard entry={entryWith('plain-text-params')} />);
    expect(html).toContain(ko.inbox.params);
    expect(html).toContain('plain-text-params');
  });

  it('absent or empty params render no params section', () => {
    for (const params of [undefined, null, {}]) {
      const html = renderToStaticMarkup(<ApprovalCard entry={entryWith(params)} />);
      expect(html).not.toContain(ko.inbox.params);
    }
  });
});
