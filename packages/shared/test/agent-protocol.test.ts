import { describe, expect, it } from 'vitest';
import {
  AgentApprovalResolveSchema,
  AgentChatRequestSchema,
  PERMISSION_CLASSES,
  PermissionSettingsPutSchema,
  PROPOSED_ACTION_PERMISSION,
  ProposedActionSchema,
  UsageGaugeDtoSchema,
  type ProposedAction,
} from '../src/index';

const VALID_ACTIONS: ProposedAction[] = [
  { kind: 'send_directive', sessionId: 's1', text: 'run the tests' },
  { kind: 'spawn_session', adapterId: 'claude', cwd: '/tmp/proj', model: 'sonnet' },
  { kind: 'answer_ask', sessionId: 's1', askId: 'a1', choice: 0 },
  { kind: 'answer_ask', sessionId: 's1', askId: 'a2', choice: [0, 2] },
  { kind: 'approve_plan', sessionId: 's1' },
  { kind: 'set_permission_mode', sessionId: 's1', mode: 'plan' },
  { kind: 'interrupt_session', sessionId: 's1' },
  { kind: 'create_board_card', title: 'Investigate flaky test' },
];

describe('ProposedActionSchema', () => {
  it('accepts every documented action shape', () => {
    for (const action of VALID_ACTIONS) {
      expect(ProposedActionSchema.parse(action)).toEqual(action);
    }
  });

  it('rejects unknown kinds — including any permission-settings mutation', () => {
    for (const kind of ['set_permission_settings', 'permission.grant', 'delete_session', 'nope']) {
      expect(ProposedActionSchema.safeParse({ kind }).success).toBe(false);
    }
  });

  it('rejects extra keys (strict wire contract)', () => {
    const r = ProposedActionSchema.safeParse({
      kind: 'send_directive',
      sessionId: 's1',
      text: 'hi',
      extra: true,
    });
    expect(r.success).toBe(false);
  });

  it('maps every kind to a permission id, and never to a self-escalation action', () => {
    const kinds = ProposedActionSchema.options.map((o) => o.shape.kind.value);
    expect(Object.keys(PROPOSED_ACTION_PERMISSION).sort()).toEqual([...kinds].sort());
    const forbidden = ['permission.grant', 'account.switch', 'harness.edit', 'session.delete'];
    for (const id of Object.values(PROPOSED_ACTION_PERMISSION)) {
      expect(forbidden).not.toContain(id);
    }
  });
});

describe('request bodies', () => {
  it('chat: non-empty text, strict', () => {
    expect(AgentChatRequestSchema.safeParse({ text: 'status?' }).success).toBe(true);
    expect(AgentChatRequestSchema.safeParse({ text: '' }).success).toBe(false);
    expect(AgentChatRequestSchema.safeParse({ text: 'x', evil: 1 }).success).toBe(false);
  });

  it('approval resolve: approve|reject only', () => {
    expect(AgentApprovalResolveSchema.safeParse({ decision: 'approve' }).success).toBe(true);
    expect(AgentApprovalResolveSchema.safeParse({ decision: 'maybe' }).success).toBe(false);
  });

  it('permission-settings put: classes constrained to the wire union', () => {
    expect(
      PermissionSettingsPutSchema.safeParse({ changes: { 'session.spawn': 'autonomous' } }).success,
    ).toBe(true);
    expect(
      PermissionSettingsPutSchema.safeParse({ changes: { 'session.spawn': 'always' } }).success,
    ).toBe(false);
    expect(PERMISSION_CLASSES).toEqual(['autonomous', 'confirm', 'forbidden']);
  });
});

describe('UsageGaugeDtoSchema', () => {
  it('accepts an honest stale-turn-gated codex gauge', () => {
    const gauge = {
      toolId: 'codex',
      available: true,
      windows: [{ label: '5h', usedPercent: 42.5, resetsAt: 1751760000000, slot: 'primary' }],
      freshness: 'stale-turn-gated',
      asOf: 1751750000000,
      note: { en: 'Updated only when a turn runs', ko: '턴이 실행될 때만 갱신됩니다' },
    };
    expect(UsageGaugeDtoSchema.parse(gauge)).toEqual(gauge);
  });

  it('rejects an unknown freshness value', () => {
    const r = UsageGaugeDtoSchema.safeParse({
      toolId: 'codex',
      available: true,
      windows: [],
      freshness: 'realtime',
    });
    expect(r.success).toBe(false);
  });
});
