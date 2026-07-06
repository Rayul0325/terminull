/**
 * Account-center render tests (M9 W1). Honesty-critical renders: a tool whose
 * adapter declares no whoami shows an explicit 확인 불가 (never a blank-green
 * card), an adapter-reported identity shows account+plan verbatim, the switch
 * confirm sheet states BOTH the new-spawns-only rule and the live-session
 * warning count, the active profile wears its badge, and a completed switch
 * shows the SERVER-reported live count. Static markup (react-dom/server);
 * store hooks re-pointed at live getState() per the established pattern.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '../i18n';
import ko from '../i18n/locales/ko.json';
import type { ToolListEntry } from '../api/types';
import { useAccountsStore } from '../stores/accounts';
import { useProfilesStore } from '../stores/profiles';
import { SwitchConfirmBody, ToolAccountCard, liveSessionCountOf } from './AccountCenterSection';

// vi.mock factories are hoisted — each re-points its store hook at the live
// getState() inline (the MachinesStrip.test pattern); all other exports real.
vi.mock('../stores/profiles', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../stores/profiles')>();
  const real = actual.useProfilesStore;
  const live = Object.assign(
    (selector?: (s: ReturnType<typeof real.getState>) => unknown) =>
      selector ? selector(real.getState()) : real.getState(),
    real,
  ) as unknown as typeof real;
  return { ...actual, useProfilesStore: live };
});
vi.mock('../stores/accounts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../stores/accounts')>();
  const real = actual.useAccountsStore;
  const live = Object.assign(
    (selector?: (s: ReturnType<typeof real.getState>) => unknown) =>
      selector ? selector(real.getState()) : real.getState(),
    real,
  ) as unknown as typeof real;
  return { ...actual, useAccountsStore: live };
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
  useProfilesStore.setState({
    profiles: [],
    active: {},
    loaded: false,
    loading: false,
    errorCode: null,
    lastSwitch: null,
  });
  useAccountsStore.setState({ entries: {} });
});

function tool(overrides: Partial<ToolListEntry['capabilities']['accounts']> = {}): ToolListEntry {
  return {
    id: 'claude',
    displayName: { en: 'Claude Code', ko: '클로드 코드' },
    capabilities: {
      liveDetection: 'none',
      transcript: 'none',
      headless: 'none',
      acp: false,
      coDrive: 'none',
      hooks: 'none',
      permissionModes: [],
      modelDiscovery: 'none',
      slashCommands: 'none',
      resume: false,
      fork: false,
      accounts: { whoami: false, usage: false, profiles: false, switch: false, ...overrides },
      harnessFiles: false,
    },
  };
}

describe('ToolAccountCard identity honesty', () => {
  it('a tool without whoami capability renders 확인 불가, never blank-green', () => {
    const html = renderToStaticMarkup(<ToolAccountCard tool={tool()} />);
    expect(html).toContain(ko.account.whoami.unavailable);
  });

  it('an adapter-reported identity renders account + plan verbatim', () => {
    useAccountsStore.setState({
      entries: {
        claude: {
          toolId: 'claude',
          supported: true,
          loading: false,
          errorCode: null,
          account: {
            whoami: { available: true, value: { account: 'rayul@example.com', plan: 'Max' } },
            profiles: { available: false, reason: { en: 'n/a', ko: '해당 없음' } },
          },
        },
      },
    });
    const html = renderToStaticMarkup(<ToolAccountCard tool={tool({ whoami: true })} />);
    expect(html).toContain('rayul@example.com');
    expect(html).toContain('Max');
    expect(html).not.toContain(ko.account.whoami.unavailable);
  });

  it('an available:false whoami renders 확인 불가 plus the adapter reason', () => {
    useAccountsStore.setState({
      entries: {
        claude: {
          toolId: 'claude',
          supported: true,
          loading: false,
          errorCode: null,
          account: {
            whoami: { available: false, reason: { en: 'not logged in', ko: '로그인 안 됨' } },
            profiles: { available: false, reason: { en: 'n/a', ko: '해당 없음' } },
          },
        },
      },
    });
    const html = renderToStaticMarkup(<ToolAccountCard tool={tool({ whoami: true })} />);
    expect(html).toContain(ko.account.whoami.unavailable);
    expect(html).toContain('로그인 안 됨');
  });
});

describe('profile rows + switch flow', () => {
  it('the active profile wears the badge; others offer the switch action', () => {
    useProfilesStore.setState({
      profiles: [{ id: 'work', toolId: 'claude', label: '업무 계정', configHome: '/fake/work' }],
      active: { claude: 'work' },
    });
    const html = renderToStaticMarkup(<ToolAccountCard tool={tool()} />);
    expect(html).toContain('업무 계정');
    expect(html).toContain(ko.account.profiles.active);
    // The default row is switchable when not active.
    expect(html).toContain(ko.account.profiles.use);
    expect(html).toContain(ko.account.profiles.default);
  });

  it('the confirm sheet body states new-spawns-only AND the live warning count', () => {
    const html = renderToStaticMarkup(
      <SwitchConfirmBody
        toolName="클로드 코드"
        targetLabel="업무 계정"
        liveCount={3}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );
    expect(html).toContain(ko.account.switch.newSpawnsOnly);
    expect(html).toContain(i18n.t('account.switch.liveWarning', { count: 3 }));
    expect(html).toContain(ko.account.switch.confirm);
    expect(html).toContain(ko.common.cancel);
  });

  it('a completed switch shows the SERVER-reported live count', () => {
    useProfilesStore.setState({
      lastSwitch: { switched: true, toolId: 'claude', profileId: 'work', liveSessionCount: 2 },
    });
    const html = renderToStaticMarkup(<ToolAccountCard tool={tool()} />);
    expect(html).toContain(i18n.t('account.switch.done', { count: 2 }));
  });

  it('liveSessionCountOf counts live sessions of the tool only', () => {
    const sessions = [
      { tool: 'claude', live: true },
      { tool: 'claude', live: false },
      { tool: 'codex', live: true },
    ];
    expect(liveSessionCountOf(sessions, 'claude')).toBe(1);
  });
});
