/**
 * The supervisor loop behind {@link createManageAgent}.
 *
 * Effect discipline (M7 contract):
 *  - the brain NEVER touches the panel: every proposal is zod-parsed
 *    (`ProposedActionSchema`) and flows through {@link PanelActions.execute},
 *    where the SERVER's permission gate + confirmation queue + audit chain
 *    apply. The optional {@link PermissionPrecheck} is defense-in-depth only:
 *    `forbidden` proposals are refused locally (audited) without ever
 *    reaching the executor — the server gate stays the final authority.
 *  - self-permission-change attempts have no verb in the union, so they fail
 *    the parse and are denied+audited here BEFORE any permission machinery
 *    runs (core's `PermissionSettings.set` additionally throws for the
 *    `agent` actor — the second layer, asserted in tests).
 *  - caps are hard stop conditions: exceeding the per-chat turn cap or the
 *    daily budget cap emits an honest, audited `agent.state` stop event and
 *    refuses further brain turns — never a silent continue.
 *  - all session-derived text enters prompts fenced (see `prompt.ts`).
 */
import { maskSecrets } from '@terminull/core';
import {
  PROPOSED_ACTION_PERMISSION,
  ProposedActionSchema,
  type AgentActionPayload,
  type AgentChatAccepted,
  type AgentRuntimeState,
  type AgentStatusDto,
  type ProposedActionKind,
} from '@terminull/shared';
import type {
  AuditEmitter,
  BrainAdapter,
  BrainEvent,
  BrainMessage,
  BrainProbe,
  BrainStopReason,
  BrainTurnInput,
  ManageAgent,
  ManageAgentCaps,
  PanelActions,
  ProposalMeta,
} from './index.js';
import { buildSystemPrompt, renderContextMessage } from './prompt.js';

/**
 * Structural slice of `@terminull/core`'s `PermissionSettings.check` used for
 * the local pre-check. Core's class satisfies it as-is; tests may substitute
 * a recording fake. Optional: without it every parsed proposal goes straight
 * to the server executor (which always re-checks).
 */
export interface PermissionPrecheck {
  check(actionId: string, actor: 'agent'): { allowed: 'yes' | 'confirm' | 'no' };
}

/** Thrown by `chat()` while a previous supervisor turn is still in flight. */
export class AgentBusyError extends Error {
  readonly code = 'agent_busy';
  constructor() {
    super('a supervisor turn is already in flight');
    this.name = 'AgentBusyError';
  }
}

/** Fully-resolved dependencies (config resolution happens in the factory). */
export interface SupervisorDeps {
  brain: BrainAdapter;
  actions: PanelActions;
  emit: AuditEmitter;
  caps: ManageAgentCaps;
  now: () => number;
  precheck?: PermissionPrecheck;
}

/** Why the chat loop stopped — drives the terminal `agent.state` event. */
type ChatStop = 'complete' | 'turn_cap' | 'budget_cap' | 'interrupted' | 'error';

interface TurnResult {
  text: string;
  outcomes: string[];
  pendingCreated: number;
  stopReason: BrainStopReason | null;
  errored: boolean;
}

/** Best-effort audit label for a proposal that failed the schema parse. */
function claimedKind(action: unknown): string {
  if (action !== null && typeof action === 'object') {
    const kind = (action as Record<string, unknown>).kind;
    if (typeof kind === 'string' && kind.length > 0) return kind;
  }
  return 'unknown';
}

export class Supervisor implements ManageAgent {
  private readonly brain: BrainAdapter;
  private readonly actions: PanelActions;
  private readonly emit: AuditEmitter;
  private readonly caps: ManageAgentCaps;
  private readonly now: () => number;
  private readonly precheck: PermissionPrecheck | undefined;

  private runtimeState: AgentRuntimeState = 'idle';
  private probeResult: BrainProbe = { availability: 'unverified' };
  private probed = false;
  private lastTurnAt: number | undefined;
  /** USD spent today; `null` = no cost observed (unknown ≠ zero). */
  private spentUsdToday: number | null = null;
  private budgetDay = '';
  /** Best-effort count (last snapshot + local pendings); the server's status
   * route composes the authoritative number from its confirmation queue. */
  private pendingApprovals = 0;
  private conversation: BrainMessage[] = [];
  private turnSeq = 0;
  private inFlight: { turnId: string; controller: AbortController; done: Promise<void> } | null =
    null;

  constructor(deps: SupervisorDeps) {
    this.brain = deps.brain;
    this.actions = deps.actions;
    this.emit = deps.emit;
    this.caps = deps.caps;
    this.now = deps.now;
    this.precheck = deps.precheck;
  }

  status(): AgentStatusDto {
    this.rollBudgetDay();
    return {
      state: this.runtimeState,
      enabled: true,
      brain: {
        id: this.brain.id,
        availability: this.probeResult.availability,
        ...(this.probeResult.version !== undefined ? { version: this.probeResult.version } : {}),
        ...(this.probeResult.detail !== undefined ? { detail: this.probeResult.detail } : {}),
      },
      caps: { ...this.caps },
      budget: { spentUsd: this.spentUsdToday, capUsd: this.caps.maxBudgetUsdPerDay },
      pendingApprovals: this.pendingApprovals,
      ...(this.lastTurnAt !== undefined ? { lastTurnAt: this.lastTurnAt } : {}),
    };
  }

  async chat(text: string): Promise<AgentChatAccepted> {
    if (this.inFlight !== null) throw new AgentBusyError();
    this.turnSeq += 1;
    const turnId = `turn-${this.turnSeq}`;
    const controller = new AbortController();
    const done = this.runChat(turnId, text, controller.signal).finally(() => {
      if (this.inFlight?.turnId === turnId) this.inFlight = null;
    });
    this.inFlight = { turnId, controller, done };
    return { turnId };
  }

  async interrupt(): Promise<void> {
    const flight = this.inFlight;
    if (flight === null) return; // idempotent
    flight.controller.abort();
    await flight.done;
  }

  // -------------------------------------------------------------------------
  // Chat loop
  // -------------------------------------------------------------------------

  private async runChat(turnId: string, text: string, signal: AbortSignal): Promise<void> {
    let pendingCreated = 0;
    try {
      this.setState('thinking', turnId);

      // Probe once, lazily. Availability stays whatever the probe reported
      // ('unverified' remains honest) — but a KNOWN-unavailable brain refuses.
      if (!this.probed) {
        this.probeResult = await this.brain.probe();
        this.probed = true;
      }
      if (this.probeResult.availability === 'unavailable') {
        this.finishSpeech(turnId);
        this.setState('error', turnId, 'brain_unavailable');
        return;
      }

      this.conversation.push({ role: 'user', text });

      let turnsUsed = 0;
      let stop: ChatStop | null = null;
      while (stop === null) {
        if (signal.aborted) {
          stop = 'interrupted';
          break;
        }
        // Budget cap first: an exhausted budget refuses even the first brain
        // invocation of a new chat (honest audited stop, no silent spend).
        if (this.budgetExhausted()) {
          stop = 'budget_cap';
          break;
        }
        if (turnsUsed >= this.caps.maxTurnsPerChat) {
          stop = 'turn_cap';
          break;
        }
        turnsUsed += 1;

        const snapshot = await this.actions.snapshot();
        this.pendingApprovals = snapshot.pendingApprovals + pendingCreated;
        const input: BrainTurnInput = {
          turnId,
          system: buildSystemPrompt(this.caps),
          messages: [...this.conversation, { role: 'user', text: renderContextMessage(snapshot) }],
        };

        const turn = await this.runBrainTurn(input, turnId, signal);
        pendingCreated += turn.pendingCreated;
        if (turn.text.length > 0) this.conversation.push({ role: 'agent', text: turn.text });
        if (turn.errored) {
          stop = 'error';
        } else if (signal.aborted || turn.stopReason === 'interrupted') {
          stop = 'interrupted';
        } else if (turn.outcomes.length === 0) {
          stop = 'complete';
        } else {
          // Feed outcomes back (panel-authored machine summary) and let the
          // brain follow up — bounded by the caps checked at the loop top.
          this.conversation.push({
            role: 'user',
            text: `Panel action outcomes (machine-generated):\n${turn.outcomes
              .map((o) => `- ${o}`)
              .join('\n')}`,
          });
        }
      }

      this.finishSpeech(turnId);
      this.lastTurnAt = this.now();
      switch (stop) {
        case 'turn_cap':
        case 'budget_cap':
          // The honest, audited cap stop — refusing further brain turns.
          this.setState('idle', turnId, stop);
          break;
        case 'interrupted':
          this.setState('idle', turnId, 'interrupted');
          break;
        case 'error':
          this.setState('error', turnId, 'brain_error');
          break;
        default:
          this.setState(pendingCreated > 0 ? 'awaiting_approval' : 'idle', turnId);
      }
    } catch (err) {
      // Never let a supervisor crash disappear: close the stream and audit.
      this.finishSpeech(turnId);
      this.setState('error', turnId, 'internal_error');
      void err;
    }
  }

  private async runBrainTurn(
    input: BrainTurnInput,
    turnId: string,
    signal: AbortSignal,
  ): Promise<TurnResult> {
    const textParts: string[] = [];
    const outcomes: string[] = [];
    let actionsSeen = 0;
    let pendingCreated = 0;
    let stopReason: BrainStopReason | null = null;
    let errored = false;

    for await (const event of this.brain.runTurn(input, signal)) {
      switch (event.kind) {
        case 'text':
          textParts.push(event.text);
          this.emit('agent.speech', { turnId, text: event.text, final: false });
          break;
        case 'usage':
          this.recordUsage(event.costUsd);
          break;
        case 'action': {
          actionsSeen += 1;
          const handled = await this.handleProposal(event, turnId, actionsSeen);
          outcomes.push(handled.summary);
          if (handled.pending) pendingCreated += 1;
          break;
        }
        case 'error':
          errored = true;
          break;
        case 'done':
          stopReason = event.stopReason;
          break;
      }
      if (stopReason !== null || signal.aborted) break;
    }
    return { text: textParts.join('\n'), outcomes, pendingCreated, stopReason, errored };
  }

  /**
   * One proposal through the pipeline: parse → pre-check → executor.
   * Locally-refused proposals (parse failure, action cap, forbidden) emit
   * their own `agent.action` denied audit; anything handed to the executor is
   * audited by the SERVER (single source for the executed-path chain).
   */
  private async handleProposal(
    event: Extract<BrainEvent, { kind: 'action' }>,
    turnId: string,
    index: number,
  ): Promise<{ summary: string; pending: boolean }> {
    const proposalId = `${turnId}-p${index}`;
    const reason = event.reason !== undefined ? maskSecrets(event.reason) : undefined;
    const parsed = ProposedActionSchema.safeParse(event.action);

    if (index > this.caps.maxActionsPerTurn) {
      // Over the per-turn action cap: refuse without touching the executor.
      const kind = parsed.success ? parsed.data.kind : claimedKind(event.action);
      this.emitDenied(proposalId, turnId, kind, parsed.success ? PROPOSED_ACTION_PERMISSION[parsed.data.kind] : 'none', reason, 'action_cap');
      return { summary: `${proposalId} (${kind}): denied (action_cap)`, pending: false };
    }

    if (!parsed.success) {
      // Unknown/malformed verbs land here — including every self-permission
      // -change attempt (the union has no such verb). Denied BEFORE any
      // permission machinery runs; audited, never silent.
      const kind = claimedKind(event.action);
      this.emitDenied(proposalId, turnId, kind, 'none', reason, 'action_not_allowed');
      return { summary: `${proposalId} (${kind}): denied (action_not_allowed)`, pending: false };
    }

    const action = parsed.data;
    const permissionAction: string | undefined = PROPOSED_ACTION_PERMISSION[action.kind];
    if (permissionAction === undefined) {
      // Runtime guard mirroring the type-level rule — unreachable unless the
      // union and the map ever drift.
      this.emitDenied(proposalId, turnId, action.kind, 'none', reason, 'action_not_allowed');
      return { summary: `${proposalId} (${action.kind}): denied (action_not_allowed)`, pending: false };
    }

    // Defense-in-depth pre-check; the server-side gate remains the authority.
    if (this.precheck !== undefined) {
      const decision = this.precheck.check(permissionAction, 'agent');
      if (decision.allowed === 'no') {
        this.emitDenied(proposalId, turnId, action.kind, permissionAction, reason, 'forbidden');
        return { summary: `${proposalId} (${action.kind}): denied (forbidden)`, pending: false };
      }
    }

    // `confirm` and `autonomous` both go to the executor: it re-checks,
    // enqueues a confirmation or runs, and emits the full audit chain.
    const meta: ProposalMeta = {
      proposalId,
      turnId,
      ...(reason !== undefined ? { reason } : {}),
    };
    try {
      const outcome = await this.actions.execute(action, meta);
      switch (outcome.status) {
        case 'executed':
          return { summary: `${proposalId} (${action.kind}): executed`, pending: false };
        case 'pending':
          this.pendingApprovals += 1;
          return {
            summary: `${proposalId} (${action.kind}): pending user approval (confirmation ${outcome.confirmationId})`,
            pending: true,
          };
        case 'denied':
          return { summary: `${proposalId} (${action.kind}): denied (${outcome.code})`, pending: false };
      }
    } catch {
      // Executor crash — audited as failed; the outcome stays honest.
      this.emitAction({
        phase: 'failed',
        proposalId,
        turnId,
        actionKind: action.kind,
        permissionAction,
        ...(reason !== undefined ? { reason } : {}),
        resultCode: 'executor_error',
      });
      return { summary: `${proposalId} (${action.kind}): failed (executor_error)`, pending: false };
    }
  }

  // -------------------------------------------------------------------------
  // Emission + accounting helpers
  // -------------------------------------------------------------------------

  private emitDenied(
    proposalId: string,
    turnId: string,
    kind: string,
    permissionAction: string,
    reason: string | undefined,
    resultCode: string,
  ): void {
    this.emitAction({
      phase: 'denied',
      proposalId,
      turnId,
      // Audit fidelity over type purity: for a proposal that failed the
      // parse we still report the CLAIMED kind on the wire (cast is local).
      actionKind: kind as ProposedActionKind,
      permissionAction,
      ...(reason !== undefined ? { reason } : {}),
      resultCode,
    });
  }

  private emitAction(payload: AgentActionPayload): void {
    this.emit('agent.action', payload);
  }

  private setState(state: AgentRuntimeState, turnId?: string, reason?: string): void {
    this.runtimeState = state;
    this.emit('agent.state', {
      state,
      ...(turnId !== undefined ? { turnId } : {}),
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  /** Close the speech stream for a turn (empty `final` chunk). */
  private finishSpeech(turnId: string): void {
    this.emit('agent.speech', { turnId, text: '', final: true });
  }

  private recordUsage(costUsd: number | undefined): void {
    this.rollBudgetDay();
    if (typeof costUsd === 'number' && Number.isFinite(costUsd)) {
      this.spentUsdToday = (this.spentUsdToday ?? 0) + costUsd;
    }
  }

  private rollBudgetDay(): void {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    if (day !== this.budgetDay) {
      this.budgetDay = day;
      this.spentUsdToday = null;
    }
  }

  private budgetExhausted(): boolean {
    this.rollBudgetDay();
    const cap = this.caps.maxBudgetUsdPerDay;
    return cap !== null && (this.spentUsdToday ?? 0) >= cap;
  }
}
