/**
 * SessionRow render tests — the glanceability + honesty contract: a HUMAN title
 * (never a bare uuid), an honest 확인 중 when the session has no lastActivity, an
 * honest — when the timestamp is unknown, and the real tool-label + summary when
 * activity is present. Static markup via react-dom/server (no jsdom); SessionRow
 * reads no stores, so no store mock is needed — only i18n must be initialized.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '../../i18n';
import ko from '../../i18n/locales/ko.json';
import type { FleetSession } from '../../api/types';
import { SessionRow } from './SessionRow';

beforeAll(async () => {
  if (!i18n.isInitialized) {
    await new Promise<void>((resolve) => i18n.on('initialized', () => resolve()));
  }
});

const NOW = 1_000_000_000;

function session(overrides: Partial<FleetSession> = {}): FleetSession {
  return { id: 's-1', tool: 'claude', live: true, origin: 'paneld', ...overrides };
}

/** Attach the additive `lastActivity` field (track A) without a type dependency. */
function withLastActivity(
  s: FleetSession,
  lastActivity: { toolName?: string; summary?: string },
): FleetSession {
  return { ...s, lastActivity } as FleetSession;
}

function render(s: FleetSession, extra: { now?: number; onOpen?: () => void } = {}): string {
  return renderToStaticMarkup(
    <SessionRow session={s} now={extra.now ?? NOW} onOpen={extra.onOpen} />,
  );
}

describe('SessionRow honesty', () => {
  it('shows the human title, never the bare uuid', () => {
    const uuid = '11111111-2222-3333-4444-555555555555';
    const html = render(session({ id: uuid, title: '리팩터 세션' }));
    expect(html).toContain('리팩터 세션');
    expect(html).not.toContain(uuid);
  });

  it('falls back to the cwd basename, then a short id — but never a bare uuid', () => {
    const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    // no title, has cwd → basename
    expect(render(session({ id: uuid, title: undefined, cwd: '/Users/x/my-proj' }))).toContain(
      'my-proj',
    );
    // no title, no cwd → id.slice(0,8), NOT the full uuid
    const html = render(session({ id: uuid, title: undefined, cwd: undefined }));
    expect(html).toContain(uuid.slice(0, 8));
    expect(html).not.toContain(uuid);
  });

  it('renders an honest 확인 중 when the session has no lastActivity', () => {
    expect(render(session())).toContain(ko.fleet.activity.unknown);
  });

  it('renders the tool label + summary when lastActivity is present', () => {
    const html = render(withLastActivity(session(), { toolName: 'Bash', summary: 'npm test' }));
    expect(html).toContain(ko.chat.toolLabel.Bash);
    expect(html).toContain('npm test');
    expect(html).not.toContain(ko.fleet.activity.unknown);
  });

  it('renders the running status + relative time from updatedAt', () => {
    const html = render(session({ live: true, updatedAt: NOW - 5 * 60_000 }));
    expect(html).toContain(ko.fleet.status.running);
    expect(html).toContain('5분 전');
  });

  it('renders an honest — for an unknown timestamp', () => {
    expect(render(session({ updatedAt: undefined }))).toContain('—');
  });

  it('is a real button when openable (keyboard-accessible), a span otherwise', () => {
    expect(render(session(), { onOpen: () => {} })).toContain('<button');
    expect(renderToStaticMarkup(<SessionRow session={session()} now={NOW} />)).not.toContain(
      '<button',
    );
  });
});
