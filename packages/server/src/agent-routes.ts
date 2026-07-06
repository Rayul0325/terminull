/**
 * `/api/agent/*` — the manage-agent REST surface: status, supervised chat,
 * permission settings (read for anyone, mutation for the USER only), and the
 * approval inbox (agent-origin confirmation cards + user-only resolution).
 *
 * Hard rule wiring: the PUT route is user-only AND core `PermissionSettings.set`
 * throws for the `agent` actor — two independent layers, both tested. Approval
 * resolution delegates to the server's shared confirmation-resolve path, so an
 * agent-origin card resolved via `/api/confirmations/*` produces the exact
 * same audit chain.
 */
import type http from 'node:http';
import path from 'node:path';
import {
  AgentPermissionMutationError,
  type PermissionClass as CorePermissionClass,
  AGENT_ACTIONS,
  type PermissionSettings,
} from '@terminull/core';
import type { EventStore } from '@terminull/core';
import {
  AgentApprovalResolveSchema,
  AgentChatRequestSchema,
  PERMISSION_CLASSES,
} from '@terminull/shared';
import { AgentBusyError, NotImplementedError, type ManageAgent } from '@terminull/manage-agent';
import { permissionSettingsDto } from './agent.js';
import type { Auth } from './auth.js';
import type { ConfirmationQueue } from './confirmations.js';
import { Router, fail, json, readJsonBody } from './http-util.js';
import { z } from 'zod';

/**
 * Loose PUT body: shape-strict but class values kept as plain strings so
 * validation can return the contract's `unknown_action` / `invalid_class`
 * codes (and stay ATOMIC) instead of a generic zod failure.
 */
const PermissionsPutLooseSchema = z
  .object({ changes: z.record(z.string().min(1), z.string().min(1)) })
  .strict();

const KNOWN_ACTION_IDS = new Set(AGENT_ACTIONS.map((a) => a.id));

/** What the agent routes borrow from the server. */
export interface AgentRouteDeps {
  auth: Auth;
  store: EventStore;
  permissions: PermissionSettings;
  confirmations: ConfirmationQueue;
  manageAgent: ManageAgent;
  stateDir: string;
  enabled: boolean;
  /** Disabled/unavailable status DTO composed by the server (honest shape). */
  disabledStatus(): unknown;
  /** The shared confirmation-resolve path (bound server closure). */
  resolveConfirmation(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    id: string,
    verb: 'approve' | 'reject',
  ): Promise<void>;
}

/** Register every `/api/agent/*` route on the server's router. */
export function registerAgentRoutes(r: Router, deps: AgentRouteDeps): void {
  r.add('GET', '/api/agent/status', (_req, res) => {
    if (!deps.enabled) {
      json(res, 200, deps.disabledStatus());
      return;
    }
    try {
      json(res, 200, deps.manageAgent.status());
    } catch (e) {
      // Honest surface while the manage-agent runtime milestone is landing:
      // a stubbed facade reads as 501, never as a fabricated healthy status.
      if (e instanceof NotImplementedError) {
        fail(res, 501, 'not_implemented');
        return;
      }
      throw e;
    }
  });

  r.add('POST', '/api/agent/chat', async (req, res) => {
    // User-only: a session hook (or the agent itself) must never puppet the
    // supervisor by feeding it chat turns.
    if (deps.auth.actorOf(req) !== 'user') {
      fail(res, 403, 'user_required');
      return;
    }
    const body = AgentChatRequestSchema.safeParse(await readJsonBody(req));
    if (!body.success) {
      fail(res, 400, 'bad_request');
      return;
    }
    if (!deps.enabled) {
      fail(res, 409, 'agent_disabled');
      return;
    }
    try {
      const accepted = await deps.manageAgent.chat(body.data.text);
      json(res, 202, accepted);
    } catch (e) {
      // One supervised turn at a time — a busy supervisor is a typed 409.
      if (e instanceof AgentBusyError) {
        fail(res, 409, 'agent_busy');
        return;
      }
      if (e instanceof NotImplementedError) {
        fail(res, 501, 'not_implemented');
        return;
      }
      throw e;
    }
  });

  r.add('GET', '/api/agent/permission-settings', (_req, res) => {
    json(res, 200, permissionSettingsDto(deps.permissions));
  });

  r.add('PUT', '/api/agent/permission-settings', async (req, res) => {
    // Layer 1: only a POSITIVELY-credentialed user mutates the settings. The
    // self-label header wins over credentials, so an agent holding the token
    // still lands here as 'agent' and is refused.
    if (deps.auth.actorOf(req) !== 'user') {
      fail(res, 403, 'user_required');
      return;
    }
    const body = PermissionsPutLooseSchema.safeParse(await readJsonBody(req));
    if (!body.success) {
      fail(res, 400, 'bad_request');
      return;
    }
    // Atomic: validate EVERY change before applying ANY.
    for (const [actionId, cls] of Object.entries(body.data.changes)) {
      if (!KNOWN_ACTION_IDS.has(actionId)) {
        fail(res, 400, 'unknown_action', { actionId });
        return;
      }
      if (!(PERMISSION_CLASSES as readonly string[]).includes(cls)) {
        fail(res, 400, 'invalid_class', { actionId, class: cls });
        return;
      }
    }
    try {
      for (const [actionId, cls] of Object.entries(body.data.changes)) {
        const result = deps.permissions.set(actionId, cls as CorePermissionClass, 'user');
        deps.store.append('permission.settings_changed', {
          actor: 'user',
          payload: { actionId: result.actionId, previous: result.previous, next: result.next },
        });
      }
    } catch (e) {
      // Layer 2 (defense-in-depth): core refuses agent mutations by throwing.
      if (e instanceof AgentPermissionMutationError) {
        fail(res, 403, 'agent_permission_mutation');
        return;
      }
      throw e;
    }
    deps.permissions.save(path.join(deps.stateDir, 'permissions.json'));
    json(res, 200, permissionSettingsDto(deps.permissions));
  });

  r.add('GET', '/api/agent/approvals', (_req, res) => {
    // One queue, one inbox: this is the confirmation queue FILTERED to the
    // manage agent's proposals (PendingApprovalCard = list entry + origin).
    const pending = deps.confirmations.list().filter((p) => p.origin?.kind === 'manage-agent');
    json(res, 200, { pending });
  });

  r.add('POST', '/api/agent/approvals/:id/resolve', async (req, res, params) => {
    const body = AgentApprovalResolveSchema.safeParse(await readJsonBody(req));
    if (!body.success) {
      fail(res, 400, 'bad_request');
      return;
    }
    // Delegate to the SAME code path as /api/confirmations/:id/approve|reject
    // (user-only enforcement + the agent.action audit chain live there).
    await deps.resolveConfirmation(
      req,
      res,
      params['id'] ?? '',
      body.data.decision === 'approve' ? 'approve' : 'reject',
    );
  });
}
