/**
 * Mobile shell render tests (M9 W8). The bar carries all five tabs
 * (상태/세션/인박스/관제/계정), the inbox tab renders the INLINE answer
 * surfaces (approve/deny on a GET-seeded confirmation reusing the same
 * AttentionSection/ApprovalsInbox as desktop), the ops tab states the
 * documented no-tiling invariant, and the sessions tab offers the stepper
 * entry. Static markup inside a MemoryRouter; injected stores re-pointed at
 * live getState(). DockWorkspace must NOT be imported by this module —
 * asserted against the module source below (the invariant is load-bearing).
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import i18n from '../i18n';
import ko from '../i18n/locales/ko.json';
import { useConnectionStore } from '../stores/connection';
import { useFleetStore } from '../stores/fleet';
import { MOBILE_TABS, MobileShell } from './MobileShell';

vi.mock('../stores/connection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../stores/connection')>();
  const real = actual.useConnectionStore;
  const live = Object.assign(
    (selector?: (s: ReturnType<typeof real.getState>) => unknown) =>
      selector ? selector(real.getState()) : real.getState(),
    real,
  ) as unknown as typeof real;
  return { ...actual, useConnectionStore: live };
});
vi.mock('../stores/fleet', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../stores/fleet')>();
  const real = actual.useFleetStore;
  const live = Object.assign(
    (selector?: (s: ReturnType<typeof real.getState>) => unknown) =>
      selector ? selector(real.getState()) : real.getState(),
    real,
  ) as unknown as typeof real;
  return { ...actual, useFleetStore: live };
});

beforeAll(async () => {
  if (!i18n.isInitialized) {
    await new Promise<void>((resolve) => i18n.on('initialized', () => resolve()));
  }
});

afterEach(() => {
  useConnectionStore.setState({ wsStatus: 'offline', seq: 0, hostConnected: null, attention: [] });
  useFleetStore.setState({ snapshot: null, loading: false, errorCode: null });
});

function render(initialTab?: 'status' | 'sessions' | 'inbox' | 'ops' | 'account'): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <MobileShell {...(initialTab !== undefined ? { initialTab } : {})} />
    </MemoryRouter>,
  );
}

describe('MobileShell', () => {
  it('renders all five bottom tabs (상태/세션/인박스/관제/계정)', () => {
    const html = render();
    expect(MOBILE_TABS).toEqual(['status', 'sessions', 'inbox', 'ops', 'account']);
    for (const label of [
      ko.mobile.tab.status,
      ko.mobile.tab.sessions,
      ko.mobile.tab.inbox,
      ko.mobile.tab.ops,
      ko.mobile.tab.account,
    ]) {
      expect(html).toContain(label);
    }
  });

  it('the inbox tab renders inline approve/deny for a GET-seeded confirmation', () => {
    useConnectionStore.getState().seedConfirmations([
      { id: 'c-1', action: 'session.spawn', actor: 'agent', params: {}, createdAt: 5 },
    ]);
    const html = render('inbox');
    expect(html).toContain(ko.inbox.approve);
    expect(html).toContain(ko.inbox.deny);
    expect(html).toContain('session.spawn');
  });

  it('the ops tab states the documented no-tiling invariant', () => {
    const html = render('ops');
    expect(html).toContain(ko.mobile.noTiling);
  });

  it('the sessions tab offers the stepper entry and honest empty state', () => {
    const html = render('sessions');
    expect(html).toContain(ko.stepper.open);
    expect(html).toContain(ko.mobile.sessionsEmpty);
  });

  it('never imports the tiled workspace (load-bearing invariant)', () => {
    const dir = path.dirname(new URL(import.meta.url).pathname);
    const source = fs.readFileSync(path.join(dir, 'MobileShell.tsx'), 'utf8');
    const importLines = source.split('\n').filter((line) => /^import\s/.test(line));
    for (const line of importLines) {
      expect(line).not.toContain('DockWorkspace');
      expect(line).not.toContain("'dockview'");
    }
  });
});
