/**
 * Manage-Agent wire contract — the REST shapes for `/api/agent/*`, the
 * {@link ProposedAction} vocabulary the supervisor agent may emit, and the
 * usage-gauge payload adapter quota surfaces converge on.
 *
 * Trust model (mirrors panel-protocol):
 *  - A {@link ProposedAction} crosses a trust boundary: it is parsed out of
 *    BRAIN OUTPUT (LLM text), so consumers MUST validate with
 *    {@link ProposedActionSchema} before acting. The union deliberately
 *    contains NO permission-settings mutation, no account switch, no harness
 *    edit and no session delete — the type-level half of the hard rule that
 *    the agent can never widen its own permissions.
 *  - Approval resolution is NOT something the agent can emit: only the
 *    user-credentialed REST route resolves a pending approval. Session/peer
 *    text can never approve anything.
 *
 * Note: {@link PermissionClass} here is the WIRE mirror of
 * `@terminull/core`'s `PermissionClass` (structurally identical string
 * unions; core cannot be imported from shared without a dependency cycle).
 * Modules that need both should alias one on import.
 */
import { z } from 'zod';
import { ACTORS } from './events.js';
import { LocalizedTextSchema, type LocalizedText } from './plugin-api.js';

// ---------------------------------------------------------------------------
// Permission classes (wire mirror of @terminull/core)
// ---------------------------------------------------------------------------

/** How an agent-initiated action is gated (wire mirror of core's union). */
export const PERMISSION_CLASSES = ['autonomous', 'confirm', 'forbidden'] as const;
export type PermissionClass = (typeof PERMISSION_CLASSES)[number];
/** Schema for {@link PermissionClass}. */
export const PermissionClassSchema = z.enum(PERMISSION_CLASSES);

/** `Actor` plus the server's honest "no positive signal" classification. */
export const REQUEST_ACTORS = [...ACTORS, 'unknown'] as const;
export type RequestActorWire = (typeof REQUEST_ACTORS)[number];

// ---------------------------------------------------------------------------
// ProposedAction — the ONLY verbs the manage agent may ask the panel to run
// ---------------------------------------------------------------------------

/** Queue a directive (text) for a session. Permission: `directive.send`. */
export const SendDirectiveActionSchema = z
  .object({
    kind: z.literal('send_directive'),
    sessionId: z.string().min(1),
    text: z.string().min(1),
  })
  .strict();

/** Spawn a new session. Permission: `session.spawn`. */
export const SpawnSessionActionSchema = z
  .object({
    kind: z.literal('spawn_session'),
    adapterId: z.string().min(1),
    cwd: z.string().min(1),
    model: z.string().min(1).optional(),
    permissionMode: z.string().min(1).optional(),
    label: z.string().min(1).max(120).optional(),
  })
  .strict();

/** Answer a session's open ask/menu. Permission: `ask.answer`. */
export const AnswerAskActionSchema = z
  .object({
    kind: z.literal('answer_ask'),
    sessionId: z.string().min(1),
    askId: z.string().min(1),
    /** Option index (array for multi-select menus). */
    choice: z.union([
      z.number().int().nonnegative(),
      z.array(z.number().int().nonnegative()).min(1),
    ]),
  })
  .strict();

/** Approve a session's pending plan. Permission: `plan.approve`. */
export const ApprovePlanActionSchema = z
  .object({
    kind: z.literal('approve_plan'),
    sessionId: z.string().min(1),
  })
  .strict();

/** Change a session's permission MODE (tool-side, e.g. claude's cycle).
 * Permission: `permission.mode`. This is NOT the panel's own settings. */
export const SetPermissionModeActionSchema = z
  .object({
    kind: z.literal('set_permission_mode'),
    sessionId: z.string().min(1),
    mode: z.string().min(1),
  })
  .strict();

/** Interrupt (Esc/SIGINT-equivalent) a session. Permission: `session.interrupt`. */
export const InterruptSessionActionSchema = z
  .object({
    kind: z.literal('interrupt_session'),
    sessionId: z.string().min(1),
  })
  .strict();

/** Create a board card. Permission: `board.edit`. */
export const CreateBoardCardActionSchema = z
  .object({
    kind: z.literal('create_board_card'),
    title: z.string().min(1).max(200),
    column: z.string().min(1).optional(),
    note: z.string().max(2000).optional(),
    sessionId: z.string().min(1).optional(),
  })
  .strict();

/**
 * Every action the manage agent may propose. Deliberately ABSENT (hard rule,
 * enforced by omission here and again at runtime in the executor):
 * permission-settings changes (`permission.grant`), `account.switch`,
 * `harness.edit`, `session.delete`.
 */
export const ProposedActionSchema = z.discriminatedUnion('kind', [
  SendDirectiveActionSchema,
  SpawnSessionActionSchema,
  AnswerAskActionSchema,
  ApprovePlanActionSchema,
  SetPermissionModeActionSchema,
  InterruptSessionActionSchema,
  CreateBoardCardActionSchema,
]);
export type ProposedAction = z.infer<typeof ProposedActionSchema>;
export type ProposedActionKind = ProposedAction['kind'];

/**
 * The 1:1 map from proposed-action kind to the core permission-action id it
 * is gated by (see `AGENT_ACTIONS` in `@terminull/core`).
 */
export const PROPOSED_ACTION_PERMISSION = {
  send_directive: 'directive.send',
  spawn_session: 'session.spawn',
  answer_ask: 'ask.answer',
  approve_plan: 'plan.approve',
  set_permission_mode: 'permission.mode',
  interrupt_session: 'session.interrupt',
  create_board_card: 'board.edit',
} as const satisfies Record<ProposedActionKind, string>;

// ---------------------------------------------------------------------------
// GET /api/agent/status
// ---------------------------------------------------------------------------

/** Coarse runtime state of the manage agent. */
export const AGENT_RUNTIME_STATES = [
  'disabled',
  'idle',
  'thinking',
  'awaiting_approval',
  'error',
] as const;
export type AgentRuntimeState = (typeof AGENT_RUNTIME_STATES)[number];

/**
 * Whether the brain backend is usable. `unverified` is the HONEST default
 * before a probe/turn has actually succeeded — never presented as green.
 */
export type BrainAvailability = 'ok' | 'unverified' | 'unavailable';

/** Response of `GET /api/agent/status`. */
export interface AgentStatusDto {
  state: AgentRuntimeState;
  enabled: boolean;
  brain: {
    /** Brain adapter id, e.g. `'claude-headless'` or `'fake'`. */
    id: string;
    availability: BrainAvailability;
    version?: string;
    detail?: LocalizedText;
  };
  caps: {
    maxTurnsPerChat: number;
    maxActionsPerTurn: number;
    /** null = no budget cap configured (surfaced, not hidden). */
    maxBudgetUsdPerDay: number | null;
  };
  budget: {
    /** null = cost unknown (e.g. brain reports none) — never fabricated. */
    spentUsd: number | null;
    capUsd: number | null;
  };
  pendingApprovals: number;
  /** Epoch ms of the last completed brain turn, when any. */
  lastTurnAt?: number;
}

// ---------------------------------------------------------------------------
// POST /api/agent/chat
// ---------------------------------------------------------------------------

/** Body of `POST /api/agent/chat` (user actor only). */
export const AgentChatRequestSchema = z
  .object({ text: z.string().min(1).max(8000) })
  .strict();
export type AgentChatRequest = z.infer<typeof AgentChatRequestSchema>;

/** 202 response: the turn runs async; progress streams on `WS /ws`. */
export interface AgentChatAccepted {
  turnId: string;
}

// ---------------------------------------------------------------------------
// Event payloads streamed on WS /ws (guarded types: agent.state / agent.speech
// / agent.action — already in GUARDED_EVENT_TYPES; payloads typed here)
// ---------------------------------------------------------------------------

/** Payload of an `agent.speech` event (supervisor chat output). */
export interface AgentSpeechPayload {
  turnId: string;
  text: string;
  /** True on the final chunk of a turn's visible text. */
  final: boolean;
}

/** Payload of an `agent.state` event. */
export interface AgentStatePayload {
  state: AgentRuntimeState;
  turnId?: string;
  /** Machine reason code, e.g. `'turn_cap'` / `'budget_cap'` / `'brain_error'`. */
  reason?: string;
}

/** Lifecycle phases of one proposed action (the audit chain). */
export const AGENT_ACTION_PHASES = [
  'proposed',
  'pending',
  'approved',
  'denied',
  'executed',
  'failed',
] as const;
export type AgentActionPhase = (typeof AGENT_ACTION_PHASES)[number];

/** Payload of an `agent.action` event — one audit-chain step. */
export interface AgentActionPayload {
  phase: AgentActionPhase;
  proposalId: string;
  turnId: string;
  actionKind: ProposedActionKind;
  /** The core permission-action id this proposal was gated by. */
  permissionAction: string;
  /** Set when phase is pending/approved/denied via the confirmation queue. */
  confirmationId?: string;
  /** Brain-supplied rationale (already masked; display only, never authority). */
  reason?: string;
  /** Machine result/denial code for executed/failed/denied phases. */
  resultCode?: string;
}

// ---------------------------------------------------------------------------
// GET /api/agent/approvals + POST /api/agent/approvals/:id/resolve
// ---------------------------------------------------------------------------

/** Marks a pending confirmation as originating from the manage agent. */
export interface AgentProposalOrigin {
  kind: 'manage-agent';
  proposalId: string;
  turnId: string;
  /** Brain rationale for the card (masked, display only). */
  reason?: string;
}

/**
 * One inbox approval card. This IS the server confirmation-queue list entry
 * (see `ConfirmationQueue.list()` in `@terminull/server`) extended with the
 * optional {@link AgentProposalOrigin} — one queue, one inbox, no duplicate.
 */
export interface PendingApprovalCard {
  id: string;
  /** Core permission-action id, e.g. `'session.spawn'`. */
  action: string;
  actor: RequestActorWire;
  sessionId?: string;
  /** Masked machine-field summary of what will run. */
  params: unknown;
  createdAt: number;
  origin?: AgentProposalOrigin;
}

/** Body of `POST /api/agent/approvals/:id/resolve` (user actor only). */
export const AgentApprovalResolveSchema = z
  .object({ decision: z.enum(['approve', 'reject']) })
  .strict();
export type AgentApprovalResolve = z.infer<typeof AgentApprovalResolveSchema>;

// ---------------------------------------------------------------------------
// GET/PUT /api/agent/permission-settings
// ---------------------------------------------------------------------------

/** One row of the permission-toggle settings UI. */
export interface PermissionActionDto {
  /** Core action id, e.g. `'directive.send'`. */
  id: string;
  /** i18n key for the human label (web owns the strings). */
  labelKey: string;
  /** Resolved current class (override + floor applied). */
  class: PermissionClass;
  defaultClass: PermissionClass;
  risk: 'low' | 'med' | 'high';
  /** Immutable minimum restrictiveness — UI renders looser options locked. */
  floor?: PermissionClass;
  requiresTwoStep: boolean;
}

/** Response of `GET /api/agent/permission-settings`. */
export interface PermissionSettingsDto {
  version: 1;
  actions: PermissionActionDto[];
}

/** Body of `PUT /api/agent/permission-settings` (user actor only). */
export const PermissionSettingsPutSchema = z
  .object({ changes: z.record(z.string().min(1), PermissionClassSchema) })
  .strict();
export type PermissionSettingsPut = z.infer<typeof PermissionSettingsPutSchema>;

// ---------------------------------------------------------------------------
// GET /api/tools/:toolId/usage — quota gauge with honest freshness
// ---------------------------------------------------------------------------

/**
 * How fresh the usage numbers are. `stale-turn-gated` = the source only
 * updates when a turn actually runs (codex `token_count` rate_limits), so the
 * gauge MUST carry an honest "updated only when a turn runs" caption.
 */
export const USAGE_FRESHNESS = ['live', 'stale-turn-gated'] as const;
export type UsageFreshness = (typeof USAGE_FRESHNESS)[number];

/** One rate-limit window rendered as a gauge segment. */
export interface UsageWindowDto {
  /** Human window label, e.g. `'5h'` / `'7d'`. */
  label: string;
  /** Percent of the window consumed. */
  usedPercent: number;
  /** Epoch ms when the window resets, when known. */
  resetsAt?: number;
  /** Source slot, e.g. codex `'primary'` / `'secondary'`. */
  slot?: string;
}

/** Response of `GET /api/tools/:toolId/usage`. */
export interface UsageGaugeDto {
  toolId: string;
  /** False when the adapter cannot read usage — with `reason`, never faked. */
  available: boolean;
  windows: UsageWindowDto[];
  freshness: UsageFreshness;
  /** Epoch ms of the observation the numbers came from. */
  asOf?: number;
  /** Adapter-supplied caveat (en+ko), e.g. codex's stale note. */
  note?: LocalizedText;
  /** Why usage is unavailable (en+ko), when `available` is false. */
  reason?: LocalizedText;
}

/** Schema for {@link UsageGaugeDto} (responses are composed server-side;
 * clients may use this to validate in tests). */
export const UsageGaugeDtoSchema = z
  .object({
    toolId: z.string().min(1),
    available: z.boolean(),
    windows: z.array(
      z
        .object({
          label: z.string().min(1),
          usedPercent: z.number(),
          resetsAt: z.number().optional(),
          slot: z.string().optional(),
        })
        .strict(),
    ),
    freshness: z.enum(USAGE_FRESHNESS),
    asOf: z.number().optional(),
    note: LocalizedTextSchema.optional(),
    reason: LocalizedTextSchema.optional(),
  })
  .strict();
