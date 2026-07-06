/**
 * The server-side {@link PanelActions} executor — the manage agent's ONLY
 * effect channel. Every proposal runs the §4 audit chain of the M7 contract:
 *
 *   agent.action(proposed) → permission.checked → [confirmation.pending +
 *   agent.action(pending)] | [execute → agent.action(executed|failed)] |
 *   agent.action(denied)
 *
 * Hard rules enforced here (runtime level; the type level lives in shared):
 *  - the actor is ALWAYS `'agent'`, never transport-derived;
 *  - proposals are re-validated with {@link ProposedActionSchema} even though
 *    the manage-agent loop already parsed them (brain output stays untrusted);
 *  - any action outside {@link PROPOSED_ACTION_PERMISSION} is denied and
 *    audited WITHOUT ever reaching the permission gate;
 *  - there is no verb that could touch permission settings — and even if one
 *    appeared, core `PermissionSettings.set` throws for the `agent` actor.
 */
import crypto from 'node:crypto';
import type { EventStore, PermissionSettings } from '@terminull/core';
import { maskSecrets } from '@terminull/core';
import {
  AdapterUnsupportedError,
  MenuNotPresentError,
  type DiscoveredSession,
  type Driver,
  type ToolAdapter,
} from '@terminull/adapter-sdk';
import {
  PROPOSED_ACTION_PERMISSION,
  ProposedActionSchema,
  type Actor,
  type AgentActionPayload,
  type ProposedAction,
  type ProposedActionKind,
} from '@terminull/shared';
import type {
  ActionOutcome,
  AgentContextSnapshot,
  PanelActions,
  ProposalMeta,
} from '@terminull/manage-agent';
import { resultCodeOf } from './agent.js';
import type { ConfirmationQueue, GateResult } from './confirmations.js';
import type { FleetSnapshot } from './fleet.js';
import { maskDeep } from './http-util.js';
import type { PaneldClient } from './paneld-client.js';
import type { SessionRegistry } from './sessions.js';

/** Spawn request the executor hands back to the server (no raw cmd surface). */
export interface AgentSpawnRequest {
  adapterId: string;
  cwd: string;
  model?: string;
  permissionMode?: string;
  label?: string;
  /** Filled by the executor ONLY for generic-pty (first allowlisted shell). */
  cmd?: string;
}

/** Everything the executor borrows from the server (closures, not privates). */
export interface AgentExecutorDeps {
  store: EventStore;
  permissions: PermissionSettings;
  confirmations: ConfirmationQueue;
  registry: SessionRegistry;
  paneld: PaneldClient;
  adapters: Map<string, ToolAdapter>;
  /** Resolved spawn allowlist (basenames) for the generic-pty cmd fallback. */
  spawnAllowlist: string[];
  deliverDirective(sessionId: string, text: string, actor: Actor): Promise<GateResult>;
  spawnSession(request: AgentSpawnRequest): Promise<GateResult>;
  fleetSnapshot(): Promise<FleetSnapshot>;
}

export class AgentExecutor implements PanelActions {
  constructor(private readonly deps: AgentExecutorDeps) {}

  /** Append one `agent.action` audit step (always the `agent` actor). */
  emitPhase(payload: AgentActionPayload): void {
    this.deps.store.append('agent.action', { actor: 'agent', payload: maskDeep(payload) });
  }

  async execute(action: ProposedAction, meta: ProposalMeta): Promise<ActionOutcome> {
    // Runtime re-validation — defense-in-depth on top of the loop's parse.
    const parsed = ProposedActionSchema.safeParse(action);
    const reason = meta.reason !== undefined ? maskSecrets(meta.reason) : undefined;
    if (!parsed.success) {
      const rawKind = (action as { kind?: unknown }).kind;
      // No permission.checked here: an unparseable proposal never reaches the gate.
      this.emitPhase({
        phase: 'denied',
        proposalId: meta.proposalId,
        turnId: meta.turnId,
        actionKind: (typeof rawKind === 'string' ? rawKind : 'unknown') as ProposedActionKind,
        permissionAction: 'none',
        resultCode: 'action_not_allowed',
        ...(reason !== undefined ? { reason } : {}),
      });
      return { status: 'denied', code: 'action_not_allowed' };
    }
    const act = parsed.data;
    const permissionAction: string | undefined = PROPOSED_ACTION_PERMISSION[act.kind];
    const sessionId = 'sessionId' in act ? act.sessionId : undefined;
    const base = {
      proposalId: meta.proposalId,
      turnId: meta.turnId,
      actionKind: act.kind,
      permissionAction: permissionAction ?? 'none',
      ...(reason !== undefined ? { reason } : {}),
    };
    if (permissionAction === undefined) {
      // Unreachable for the current union, but the runtime guard is the point.
      this.emitPhase({ ...base, phase: 'denied', resultCode: 'action_not_allowed' });
      return { status: 'denied', code: 'action_not_allowed' };
    }

    this.emitPhase({ ...base, phase: 'proposed' });
    const check = this.deps.permissions.check(permissionAction, 'agent');
    this.deps.store.append('permission.checked', {
      actor: 'agent',
      ...(sessionId !== undefined ? { sessionId } : {}),
      payload: {
        action: permissionAction,
        decision: check.allowed,
        requestActor: 'agent',
        resolvedClass: check.resolvedClass,
        requiresTwoStep: check.requiresTwoStep,
      },
    });
    if (check.allowed === 'no') {
      this.emitPhase({ ...base, phase: 'denied', resultCode: 'forbidden' });
      return { status: 'denied', code: 'forbidden' };
    }
    if (check.allowed === 'confirm') {
      const origin = {
        kind: 'manage-agent' as const,
        proposalId: meta.proposalId,
        turnId: meta.turnId,
        ...(reason !== undefined ? { reason } : {}),
      };
      const pending = this.deps.confirmations.add({
        action: permissionAction,
        actor: 'agent',
        ...(sessionId !== undefined ? { sessionId } : {}),
        params: maskDeep(act),
        origin,
        execute: () => this.run(act),
      });
      this.deps.store.append('confirmation.pending', {
        actor: 'agent',
        ...(sessionId !== undefined ? { sessionId } : {}),
        payload: {
          confirmationId: pending.id,
          action: permissionAction,
          params: pending.params,
          origin,
        },
      });
      this.emitPhase({ ...base, phase: 'pending', confirmationId: pending.id });
      return { status: 'pending', confirmationId: pending.id };
    }
    try {
      const result = await this.run(act);
      const ok = result.status < 400;
      this.emitPhase({
        ...base,
        phase: ok ? 'executed' : 'failed',
        resultCode: resultCodeOf(result),
      });
      return ok
        ? { status: 'executed', result: result.body }
        : { status: 'denied', code: resultCodeOf(result) };
    } catch {
      this.emitPhase({ ...base, phase: 'failed', resultCode: 'internal_error' });
      return { status: 'denied', code: 'internal_error' };
    }
  }

  /**
   * Read-only, pre-masked context for the brain. Labels/summaries are
   * session-derived (UNTRUSTED) — the manage agent MUST additionally pass them
   * through `fenceUntrusted` before any prompt inclusion.
   */
  async snapshot(): Promise<AgentContextSnapshot> {
    const fleet = await this.deps.fleetSnapshot();
    const sessions = fleet.sessions.map((s) => ({
      id: s.id,
      tool: s.tool,
      ...(s.title !== undefined ? { label: maskSecrets(s.title) } : {}),
      state: s.live ? 'live' : 'ended',
    }));
    const asks = [...this.deps.store.asks.entries()].map(([askId, ev]) => {
      const p = ev.payload;
      const text =
        p !== null && typeof p === 'object' ? (p as Record<string, unknown>)['text'] : undefined;
      return {
        askId,
        ...(ev.sessionId !== undefined ? { sessionId: ev.sessionId } : {}),
        ...(typeof text === 'string' ? { summary: maskSecrets(text) } : {}),
      };
    });
    return { sessions, asks, pendingApprovals: this.deps.confirmations.list().length };
  }

  /** Run one VALIDATED action (direct `autonomous` path or approved closure). */
  private async run(act: ProposedAction): Promise<GateResult> {
    switch (act.kind) {
      case 'send_directive':
        return this.deps.deliverDirective(act.sessionId, act.text, 'agent');
      case 'spawn_session': {
        const request: AgentSpawnRequest = {
          adapterId: act.adapterId,
          cwd: act.cwd,
          ...(act.model !== undefined ? { model: act.model } : {}),
          ...(act.permissionMode !== undefined ? { permissionMode: act.permissionMode } : {}),
          ...(act.label !== undefined ? { label: act.label } : {}),
          // A ProposedAction carries no raw cmd (by design — the agent cannot
          // name arbitrary binaries); generic-pty falls back to the first
          // allowlisted shell and stays allowlist-gated in the server.
          ...(act.adapterId === 'generic-pty' && this.deps.spawnAllowlist[0] !== undefined
            ? { cmd: this.deps.spawnAllowlist[0] }
            : {}),
        };
        return this.deps.spawnSession(request);
      }
      case 'answer_ask':
        // v1: `askId` is correlation-only — the driver answers the session's
        // CURRENT menu, verified against a fresh screen snapshot.
        return this.driverOp(act.sessionId, 'answerMenu', (driver, screen) =>
          driver.answerMenu({
            screen,
            choice: act.choice,
            ...(Array.isArray(act.choice) ? { multiSelect: true } : {}),
          }),
        );
      case 'approve_plan':
        return this.driverOp(act.sessionId, 'approvePlan', (driver, screen) =>
          driver.approvePlan(screen),
        );
      case 'set_permission_mode':
        return this.driverOp(act.sessionId, 'setPermissionMode', (driver, screen) =>
          driver.setPermissionMode(act.mode, screen),
        );
      case 'interrupt_session':
        return this.driverOp(act.sessionId, 'interrupt', (driver) => driver.interrupt(), {
          needsScreen: false,
        });
      case 'create_board_card': {
        // The event IS the v1 board contract (like directive.queued).
        const cardId = crypto.randomUUID();
        this.deps.store.append('board.card_created', {
          actor: 'agent',
          ...(act.sessionId !== undefined ? { sessionId: act.sessionId } : {}),
          payload: maskDeep({
            cardId,
            title: act.title,
            ...(act.column !== undefined ? { column: act.column } : {}),
            ...(act.note !== undefined ? { note: act.note } : {}),
            ...(act.sessionId !== undefined ? { sessionId: act.sessionId } : {}),
          }),
        });
        return { status: 201, body: { created: true, cardId } };
      }
    }
  }

  /** Drive one session driver method with typed, honest failure mapping. */
  private async driverOp(
    sessionId: string,
    operation: string,
    op: (driver: Driver, screen: string) => Promise<void>,
    opts: { needsScreen?: boolean } = {},
  ): Promise<GateResult> {
    const needsScreen = opts.needsScreen ?? true;
    const session = this.deps.registry.get(sessionId);
    if (!session) return { status: 404, body: { code: 'not_found', sessionId } };
    if (!session.running) return { status: 409, body: { code: 'session_ended', sessionId } };
    if (!this.deps.paneld.connected) return { status: 503, body: { code: 'host_unavailable' } };
    const adapter = this.deps.adapters.get(session.adapterId);
    if (!adapter) {
      return { status: 400, body: { code: 'unknown_adapter', adapterId: session.adapterId } };
    }
    const discovered: DiscoveredSession = {
      id: session.id,
      tool: session.adapterId,
      live: true,
      cwd: session.cwd,
    };
    const driver = adapter.driverFor(discovered, {
      inject: async (bytes) => {
        await this.deps.paneld.ensureAttached(session.sid);
        this.deps.paneld.input(session.sid, Buffer.from(bytes));
      },
    });
    if (!driver) return { status: 422, body: { code: 'adapter_unsupported', operation } };
    let screen = '';
    if (needsScreen) {
      try {
        screen = await this.captureScreenTail(session.sid);
      } catch {
        return { status: 503, body: { code: 'screen_unavailable' } };
      }
    }
    try {
      await op(driver, screen);
      return { status: 200, body: { ok: true, operation } };
    } catch (e) {
      if (e instanceof AdapterUnsupportedError) {
        // Capability honesty: a typed refusal, never a silent no-op. A
        // LocalizedText `reason` is passed through ONLY when the adapter
        // attached one (the base SDK error carries just the operation).
        const reason = (e as { reason?: unknown }).reason;
        return {
          status: 422,
          body: {
            code: 'adapter_unsupported',
            operation: e.operation,
            ...(reason !== undefined ? { reason } : {}),
          },
        };
      }
      if (e instanceof MenuNotPresentError) {
        return { status: 409, body: { code: 'menu_not_present', observed: e.observed } };
      }
      return { status: 502, body: { code: 'driver_failed', operation } };
    }
  }

  /**
   * Bounded screen capture: replay the session's PTY output through a
   * dedicated read-only attachment and keep the tail. Drivers verify prompts
   * against this before ANY keystroke — never fed with fabricated screens.
   */
  private async captureScreenTail(sid: number, settleMs = 150, maxMs = 750): Promise<string> {
    const attachment = await this.deps.paneld.openAttachment(sid, {
      sinceSeq: 0,
      readOnly: true,
    });
    return new Promise<string>((resolve) => {
      const chunks: Buffer[] = [];
      let done = false;
      let settle: NodeJS.Timeout | undefined;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(settle);
        clearTimeout(hard);
        attachment.close();
        // Hand drivers a bounded tail (current prompt), not the full history.
        resolve(Buffer.concat(chunks).toString('utf8').slice(-16384));
      };
      settle = setTimeout(finish, settleMs);
      const hard = setTimeout(finish, maxMs);
      attachment.onOut((data) => {
        chunks.push(data);
        clearTimeout(settle);
        settle = setTimeout(finish, settleMs);
      });
      attachment.onExit(finish);
      attachment.onClose(finish);
    });
  }
}
