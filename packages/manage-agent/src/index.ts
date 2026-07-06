/**
 * `@terminull/manage-agent` — the supervisor "Manage Agent".
 *
 * The manage agent is a brain (LLM subprocess, v1: `claude -p
 * --output-format stream-json`) supervising the panel's sessions. It NEVER
 * touches the panel directly: every effect flows as a wire-validated
 * {@link ProposedAction} through the {@link PanelActions} executor that the
 * SERVER implements — where the normal permission gate, confirmation queue
 * and audit events apply, always with the `agent` actor.
 *
 * Hard rules baked into this contract:
 *  - The agent can NEVER modify its own permission settings: the
 *    ProposedAction union has no such verb (type level), and the executor
 *    must additionally refuse any action whose mapped permission id is not in
 *    {@link PROPOSED_ACTION_PERMISSION}'s range (runtime level).
 *  - Session/peer-derived text is UNTRUSTED: it enters a brain prompt only
 *    through {@link fenceUntrusted}, and can never approve/deny a pending
 *    confirmation (approvals are user-credentialed REST, not prompt text).
 *  - Honesty: brain availability starts `'unverified'` until a probe/turn
 *    actually succeeds; unknown cost is `null`, never a fabricated number.
 *
 * Contract doc: `.claude/progress/m7-contract.md` (repo root). The M7 builder
 * implemented the runtime behind the contracted surface: the supervisor loop
 * lives in `supervisor.ts`, the headless Claude brain in `claude-brain.ts`,
 * prompt assembly in `prompt.ts`, fencing in `fence.ts` — all re-exported
 * here, additively.
 */
import type {
  AgentChatAccepted,
  AgentStatusDto,
  AgentActionPayload,
  AgentSpeechPayload,
  AgentStatePayload,
  LocalizedText,
  ProposedAction,
} from '@terminull/shared';
import { PROPOSED_ACTION_PERMISSION } from '@terminull/shared';
import { Supervisor, type PermissionPrecheck } from './supervisor.js';

// Re-export the wire vocabulary builders and tests reach for constantly, so
// `@terminull/manage-agent` is self-sufficient to implement against.
export { PROPOSED_ACTION_PERMISSION };
export type { ProposedAction, AgentStatusDto, AgentChatAccepted };

// ---------------------------------------------------------------------------
// Brain abstraction
// ---------------------------------------------------------------------------

/** Result of probing a brain backend WITHOUT running a full turn. */
export interface BrainProbe {
  /** `'unverified'` until a probe/turn has actually succeeded — honest. */
  availability: 'ok' | 'unverified' | 'unavailable';
  version?: string;
  detail?: LocalizedText;
}

/** One message of the supervisor conversation, oldest first. */
export interface BrainMessage {
  role: 'user' | 'agent';
  /** Untrusted content inside has ALREADY passed {@link fenceUntrusted}. */
  text: string;
}

/** Input to one brain turn. Prompt assembly (and fencing) happens upstream. */
export interface BrainTurnInput {
  turnId: string;
  /** Panel-authored system prompt (trusted). */
  system: string;
  /** Conversation so far, including the new user message. */
  messages: BrainMessage[];
}

/** Why a brain turn stopped. */
export type BrainStopReason = 'end_turn' | 'turn_cap' | 'budget_cap' | 'interrupted' | 'error';

/**
 * One streamed brain event. `action` payloads are UNVALIDATED model output
 * until the manage agent zod-parses them (`ProposedActionSchema`) — a brain
 * adapter must never be trusted to have done so.
 */
export type BrainEvent =
  | { kind: 'text'; text: string; final?: boolean }
  | { kind: 'action'; action: unknown; reason?: string }
  | { kind: 'usage'; costUsd?: number; inputTokens?: number; outputTokens?: number }
  | { kind: 'done'; stopReason: BrainStopReason }
  | { kind: 'error'; code: string; detail?: string };

/**
 * A brain backend. v1 = `claude -p --output-format stream-json` subprocess;
 * tests inject a FakeBrain — unit tests NEVER spawn a real agent CLI.
 */
export interface BrainAdapter {
  /** Stable id, e.g. `'claude-headless'` / `'fake'`. */
  readonly id: string;
  probe(): Promise<BrainProbe>;
  /** Run one turn; the stream ends with a `done` (or `error`) event. */
  runTurn(input: BrainTurnInput, signal?: AbortSignal): AsyncIterable<BrainEvent>;
}

// ---------------------------------------------------------------------------
// PanelActions — the ONLY effect channel (server implements)
// ---------------------------------------------------------------------------

/** Correlation metadata attached to every proposal execution. */
export interface ProposalMeta {
  proposalId: string;
  turnId: string;
  /** Brain rationale (masked upstream; display only, never authority). */
  reason?: string;
}

/** Honest outcome of executing one proposal through the server gate. */
export type ActionOutcome =
  | { status: 'executed'; result?: unknown }
  | { status: 'pending'; confirmationId: string }
  | { status: 'denied'; code: string };

/**
 * Read-only, pre-masked context the brain may see. Fields marked UNTRUSTED
 * carry session-derived text and MUST pass {@link fenceUntrusted} before they
 * are ever placed in a prompt.
 */
export interface AgentContextSnapshot {
  sessions: Array<{
    id: string;
    tool: string;
    /** UNTRUSTED (user/session-named). */
    label?: string;
    state?: string;
  }>;
  asks: Array<{
    askId: string;
    sessionId?: string;
    /** UNTRUSTED (session-derived question text). */
    summary?: string;
  }>;
  pendingApprovals: number;
}

/**
 * The executor interface the SERVER implements. `execute` runs the standard
 * permission gate as the `agent` actor and emits the full audit chain
 * (`agent.action` proposed → permission.checked → confirmation.* / executed).
 * It must refuse — `{status:'denied'}` — any action that fails
 * `ProposedActionSchema` or maps outside {@link PROPOSED_ACTION_PERMISSION}.
 */
export interface PanelActions {
  execute(action: ProposedAction, meta: ProposalMeta): Promise<ActionOutcome>;
  snapshot(): Promise<AgentContextSnapshot>;
}

// ---------------------------------------------------------------------------
// Audit emitter + config + facade
// ---------------------------------------------------------------------------

/** Guarded event types the manage agent emits through the server's store. */
export type AgentAuditType = 'agent.state' | 'agent.speech' | 'agent.action';

/** Payload union matching {@link AgentAuditType}. */
export type AgentAuditPayload = AgentStatePayload | AgentSpeechPayload | AgentActionPayload;

/** Sink for audit events — the server passes a `store.append` wrapper. */
export type AuditEmitter = (type: AgentAuditType, payload: AgentAuditPayload) => void;

/** Hard caps — a turn/budget cap is a stop condition, never a warning. */
export interface ManageAgentCaps {
  /** Brain invocations per `chat()` call (agent loop guard). */
  maxTurnsPerChat: number;
  /** Proposals accepted per brain turn; extras are denied + audited. */
  maxActionsPerTurn: number;
  /** USD/day; `null` = no cap configured (surfaced honestly in status). */
  maxBudgetUsdPerDay: number | null;
}

/** Default caps applied when {@link ManageAgentConfig.caps} omits a field. */
export const DEFAULT_CAPS: ManageAgentCaps = {
  maxTurnsPerChat: 4,
  maxActionsPerTurn: 5,
  maxBudgetUsdPerDay: null,
};

/** Options accepted by {@link createManageAgent}. */
export interface ManageAgentConfig {
  brain: BrainAdapter;
  actions: PanelActions;
  emit: AuditEmitter;
  caps?: Partial<ManageAgentCaps>;
  /** Injected clock for deterministic tests. */
  now?: () => number;
  /**
   * OPTIONAL local pre-check against the panel's permission settings (core's
   * `PermissionSettings` satisfies this structurally). `forbidden` proposals
   * are refused + audited locally without ever reaching the executor; the
   * SERVER-side gate remains the final authority for everything else.
   * Additive M7 builder field — omitting it changes nothing contracted.
   */
  precheck?: PermissionPrecheck;
}

/**
 * The supervisor facade the server mounts at `/api/agent/*`. Deliberately has
 * NO permission-settings surface — settings live in `@terminull/core`'s
 * `PermissionSettings`, whose `set()` throws for the `agent` actor.
 */
export interface ManageAgent {
  /** Snapshot for `GET /api/agent/status`. */
  status(): AgentStatusDto;
  /** Start one supervised chat turn (async; progress streams as events). */
  chat(text: string): Promise<AgentChatAccepted>;
  /** Abort the in-flight turn, if any (idempotent). */
  interrupt(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Injection fencing (implementation in fence.ts; surface unchanged)
// ---------------------------------------------------------------------------

export { FENCE_CLOSE, FENCE_OPEN, fenceUntrusted } from './fence.js';

// ---------------------------------------------------------------------------
// Implementation re-exports (additive to the M7 contract surface)
// ---------------------------------------------------------------------------

export {
  ClaudeBrainAdapter,
  composeTurnPrompt,
  parseStreamJsonLine,
  type BrainChildProcess,
  type BrainSpawn,
  type BrainSpawnOptions,
  type ClaudeBrainOptions,
} from './claude-brain.js';
export {
  ACTION_LINE_PREFIX,
  UNTRUSTED_AUTHORITY_STATEMENT,
  buildSystemPrompt,
  renderContextMessage,
} from './prompt.js';
export { AgentBusyError, type PermissionPrecheck } from './supervisor.js';

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Thrown by not-yet-built runtime paths. Kept exported for contract
 * compatibility (the M7 scaffold threw it from every facade method); the
 * implemented runtime no longer throws it anywhere.
 */
export class NotImplementedError extends Error {
  readonly code = 'NOT_IMPLEMENTED';
  constructor(what: string) {
    super(`${what} is not implemented yet (M7 contract stub)`);
    this.name = 'NotImplementedError';
  }
}

/**
 * Build a manage agent: resolve caps over {@link DEFAULT_CAPS} and mount the
 * supervisor loop. The returned facade has exactly `status`/`chat`/
 * `interrupt` — deliberately NO permission surface.
 */
export function createManageAgent(config: ManageAgentConfig): ManageAgent {
  const caps: ManageAgentCaps = { ...DEFAULT_CAPS, ...config.caps };
  return new Supervisor({
    brain: config.brain,
    actions: config.actions,
    emit: config.emit,
    caps,
    now: config.now ?? Date.now,
    ...(config.precheck !== undefined ? { precheck: config.precheck } : {}),
  });
}
