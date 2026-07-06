/**
 * Session-create stepper render tests (M9 W5). The confirm step must show the
 * full summary (tool/machine/cwd/model/permission) plus the ACTIVE
 * account-profile badge; the machine step offers connected machines only;
 * model-discovery honesty renders the 422 note instead of an empty picker.
 * Static markup; injected stores re-pointed at live getState().
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '../i18n';
import ko from '../i18n/locales/ko.json';
import { useMachinesStore } from '../stores/machines';
import { useProfilesStore } from '../stores/profiles';
import { useSpawnStepperStore } from '../stores/spawnStepper';
import { useToolsStore } from '../stores/tools';
import { ConfirmSummary, SessionCreateStepper } from './SessionCreateStepper';

vi.mock('../stores/spawnStepper', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../stores/spawnStepper')>();
  const real = actual.useSpawnStepperStore;
  const live = Object.assign(
    (selector?: (s: ReturnType<typeof real.getState>) => unknown) =>
      selector ? selector(real.getState()) : real.getState(),
    real,
  ) as unknown as typeof real;
  return { ...actual, useSpawnStepperStore: live };
});
vi.mock('../stores/tools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../stores/tools')>();
  const real = actual.useToolsStore;
  const live = Object.assign(
    (selector?: (s: ReturnType<typeof real.getState>) => unknown) =>
      selector ? selector(real.getState()) : real.getState(),
    real,
  ) as unknown as typeof real;
  return { ...actual, useToolsStore: live };
});
vi.mock('../stores/machines', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../stores/machines')>();
  const real = actual.useMachinesStore;
  const live = Object.assign(
    (selector?: (s: ReturnType<typeof real.getState>) => unknown) =>
      selector ? selector(real.getState()) : real.getState(),
    real,
  ) as unknown as typeof real;
  return { ...actual, useMachinesStore: live };
});
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

beforeAll(async () => {
  if (!i18n.isInitialized) {
    await new Promise<void>((resolve) => i18n.on('initialized', () => resolve()));
  }
});

afterEach(() => {
  useSpawnStepperStore.getState().openStepper();
  useSpawnStepperStore.setState({ open: false });
  useToolsStore.setState({ tools: [], loaded: false, loading: false, errorCode: null });
  useMachinesStore.setState({ machines: {}, loading: false, errorCode: null });
  useProfilesStore.setState({ profiles: [], active: {}, lastSwitch: null });
});

const CLAUDE_TOOL = {
  id: 'claude',
  displayName: { en: 'Claude Code', ko: '클로드 코드' },
  capabilities: {
    liveDetection: 'none',
    transcript: 'none',
    headless: 'none',
    acp: false,
    coDrive: 'none',
    hooks: 'none',
    permissionModes: ['default', 'plan'],
    modelDiscovery: 'dynamic',
    slashCommands: 'none',
    resume: false,
    fork: false,
    accounts: { whoami: false, usage: false, profiles: false, switch: false },
    harnessFiles: true,
  },
} as const;

describe('ConfirmSummary', () => {
  it('shows tool/machine/cwd/model/permission plus the active profile badge', () => {
    const html = renderToStaticMarkup(
      <ConfirmSummary
        toolName="클로드 코드"
        machineName="Mars"
        cwd="/w/proj"
        modelLabel="Opus 4.8"
        permissionMode="plan"
        profileLabel="업무 계정"
      />,
    );
    for (const text of ['클로드 코드', 'Mars', '/w/proj', 'Opus 4.8', 'plan']) {
      expect(html).toContain(text);
    }
    expect(html).toContain(i18n.t('stepper.profileBadge', { profile: '업무 계정' }));
  });
});

describe('SessionCreateStepper steps', () => {
  it('machine step offers local + CONNECTED machines only, with the note', () => {
    useToolsStore.setState({ tools: [{ ...CLAUDE_TOOL, capabilities: { ...CLAUDE_TOOL.capabilities, permissionModes: [...CLAUDE_TOOL.capabilities.permissionModes] } }] });
    useMachinesStore.setState({
      machines: {
        mars: { id: 'mars', label: 'Mars', state: 'connected', lastSeenAt: 1 },
        pluto: { id: 'pluto', label: 'Pluto', state: 'stale', lastSeenAt: 1 },
      },
    });
    useSpawnStepperStore.setState({ open: true, step: 'machine', toolId: 'claude' });
    const html = renderToStaticMarkup(<SessionCreateStepper />);
    expect(html).toContain(ko.stepper.machineNote);
    expect(html).toContain(ko.machines.local);
    expect(html).toContain('Mars');
    expect(html).not.toContain('Pluto');
  });

  it('model step renders the honest 422 note instead of an empty picker', () => {
    useSpawnStepperStore.setState({
      open: true,
      step: 'model',
      toolId: 'generic-pty',
      modelsSupported: false,
      modelsErrorCode: 'adapter_unsupported',
    });
    const html = renderToStaticMarkup(<SessionCreateStepper />);
    expect(html).toContain(ko.stepper.modelUnsupported);
    expect(html).not.toContain(ko.stepper.modelDefault);
  });

  it('confirm step shows the summary + default-profile badge and the spawn action', () => {
    useToolsStore.setState({ tools: [{ ...CLAUDE_TOOL, capabilities: { ...CLAUDE_TOOL.capabilities, permissionModes: [...CLAUDE_TOOL.capabilities.permissionModes] } }] });
    useSpawnStepperStore.setState({
      open: true,
      step: 'confirm',
      toolId: 'claude',
      machine: 'local',
      cwd: '/w/proj',
      model: null,
      permissionMode: 'plan',
    });
    const html = renderToStaticMarkup(<SessionCreateStepper />);
    expect(html).toContain('/w/proj');
    expect(html).toContain('plan');
    expect(html).toContain(i18n.t('stepper.profileBadge', { profile: ko.account.profiles.default }));
    expect(html).toContain(ko.stepper.spawn);
  });
});
