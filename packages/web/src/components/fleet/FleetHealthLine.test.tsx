/**
 * FleetHealthLine render tests — the single glanceable verdict per store state:
 * a not-online websocket → 연결 끊김 (offline, never green-by-default), a pending
 * attention OR approval item → 개입 필요 (attention), an online socket with a
 * clean board → 정상 (ok). Static markup via react-dom/server; the connection +
 * approvals store hooks are re-pointed at their live getState() (the same
 * pattern FleetPanel.test / AttentionSection.test use — renderToStaticMarkup
 * otherwise reads zustand's server snapshot and ignores setState).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '../../i18n';
import ko from '../../i18n/locales/ko.json';
import type { ApprovalEntry } from '../../stores/approvals';
import { useApprovalsStore } from '../../stores/approvals';
import { useConnectionStore } from '../../stores/connection';
import { FleetHealthLine } from './FleetHealthLine';

vi.mock('../../stores/connection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/connection')>();
  const real = actual.useConnectionStore;
  const live = Object.assign(
    (selector?: (s: ReturnType<typeof real.getState>) => unknown) =>
      selector ? selector(real.getState()) : real.getState(),
    real,
  ) as unknown as typeof real;
  return { ...actual, useConnectionStore: live };
});
vi.mock('../../stores/approvals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/approvals')>();
  const real = actual.useApprovalsStore;
  const live = Object.assign(
    (selector?: (s: ReturnType<typeof real.getState>) => unknown) =>
      selector ? selector(real.getState()) : real.getState(),
    real,
  ) as unknown as typeof real;
  return { ...actual, useApprovalsStore: live };
});

beforeAll(async () => {
  if (!i18n.isInitialized) {
    await new Promise<void>((resolve) => i18n.on('initialized', () => resolve()));
  }
});

afterEach(() => {
  useConnectionStore.setState({ wsStatus: 'offline', seq: 0, hostConnected: null, attention: [] });
  useApprovalsStore.setState({ entries: [], loading: false, errorCode: null });
});

function pendingEntry(): ApprovalEntry {
  return {
    card: {
      id: 'c-1',
      action: 'session.spawn',
      actor: 'agent',
      params: {},
      createdAt: 1,
      origin: { kind: 'manage-agent', proposalId: 'p-1', turnId: 't-1' },
    },
    state: 'pending',
    trail: [],
  };
}

function render(): string {
  return renderToStaticMarkup(<FleetHealthLine />);
}

describe('FleetHealthLine', () => {
  it('a not-online websocket is offline — never green-by-default', () => {
    useConnectionStore.setState({ wsStatus: 'offline' });
    expect(render()).toContain(ko.fleet.health.offline);
  });

  it('a still-connecting websocket is also offline (liveness unverified)', () => {
    useConnectionStore.setState({ wsStatus: 'connecting' });
    const html = render();
    expect(html).toContain(ko.fleet.health.offline);
    expect(html).not.toContain(ko.fleet.health.ok);
  });

  it('online + a pending attention item is attention', () => {
    useConnectionStore.setState({
      wsStatus: 'online',
      attention: [{ key: 'ask:a-1', kind: 'ask', ts: 1 }],
    });
    expect(render()).toContain(ko.fleet.health.attention);
  });

  it('online + a pending approval (no attention item) is still attention', () => {
    useConnectionStore.setState({ wsStatus: 'online', attention: [] });
    useApprovalsStore.setState({ entries: [pendingEntry()], loading: false, errorCode: null });
    expect(render()).toContain(ko.fleet.health.attention);
  });

  it('online + a clean board is ok', () => {
    useConnectionStore.setState({ wsStatus: 'online', attention: [] });
    const html = render();
    expect(html).toContain(ko.fleet.health.ok);
    expect(html).not.toContain(ko.fleet.health.attention);
  });
});
