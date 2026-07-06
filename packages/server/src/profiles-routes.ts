/**
 * `/api/profiles*` — the account-profile registry surface (M9 D1/D2).
 *
 * Create/delete are USER-ONLY (agents must not mint pointers at config
 * homes); switching is gated by `account.switch` (default FORBIDDEN for
 * agents). A switch mutates `active[toolId]` for NEW spawns only: live
 * sessions are counted into `liveSessionCount` (the honest UI warning),
 * never restarted. Credentials are never read, copied, or bridged — a
 * profile is a pointer, and the server never inspects the configHome.
 */
import type http from 'node:http';
import type { ToolAdapter } from '@terminull/adapter-sdk';
import type { EventStore } from '@terminull/core';
import {
  DEFAULT_PROFILE_ID,
  ProfileSwitchRequestSchema,
  ToolProfileDtoSchema,
  type Actor,
  type ProfileSwitchResponse,
} from '@terminull/shared';
import type { Auth } from './auth.js';
import type { GateResult } from './confirmations.js';
import { Router, fail, json, readJsonBody } from './http-util.js';
import type { ProfilesRegistry } from './profiles.js';

/** What the profile routes borrow from the server. */
export interface ProfilesRouteDeps {
  auth: Auth;
  store: EventStore;
  registry: ProfilesRegistry;
  adapters: Map<string, ToolAdapter>;
  /** RUNNING sessions of a tool across all machines (the switch warning). */
  liveSessionCount(toolId: string): number;
  /** The server's single permission decision point (bound closure). */
  gate(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    action: string,
    opts: { params?: unknown; execute: (actor: Actor) => Promise<GateResult> },
  ): Promise<void>;
}

/** Register every `/api/profiles*` route on the server's router. */
export function registerProfilesRoutes(r: Router, deps: ProfilesRouteDeps): void {
  r.add('GET', '/api/profiles', (_req, res) => {
    json(res, 200, deps.registry.snapshot());
  });

  r.add('POST', '/api/profiles', async (req: http.IncomingMessage, res) => {
    // Only a POSITIVELY-credentialed user mints profile pointers.
    if (deps.auth.actorOf(req) !== 'user') {
      fail(res, 403, 'user_required');
      return;
    }
    const body = ToolProfileDtoSchema.safeParse(await readJsonBody(req));
    if (!body.success) {
      fail(res, 400, 'bad_request');
      return;
    }
    if (body.data.id === DEFAULT_PROFILE_ID) {
      fail(res, 400, 'profile_id_reserved');
      return;
    }
    if (deps.registry.has(body.data.toolId, body.data.id)) {
      fail(res, 409, 'profile_id_duplicate', { toolId: body.data.toolId, id: body.data.id });
      return;
    }
    deps.registry.create(body.data);
    json(res, 201, { created: true, profile: body.data });
  });

  r.add('DELETE', '/api/profiles/:toolId/:profileId', (req: http.IncomingMessage, res, params) => {
    if (deps.auth.actorOf(req) !== 'user') {
      fail(res, 403, 'user_required');
      return;
    }
    const toolId = params['toolId'] ?? '';
    const profileId = params['profileId'] ?? '';
    if (profileId === DEFAULT_PROFILE_ID) {
      // `default` is implicit — it can be neither stored nor deleted.
      fail(res, 400, 'profile_id_reserved');
      return;
    }
    // Registry entry ONLY — the configHome's contents are untouched.
    if (!deps.registry.delete(toolId, profileId)) {
      fail(res, 404, 'unknown_profile', { toolId, profileId });
      return;
    }
    json(res, 200, { deleted: true });
  });

  r.add('POST', '/api/profiles/switch', async (req, res) => {
    const body = ProfileSwitchRequestSchema.safeParse(await readJsonBody(req));
    if (!body.success) {
      fail(res, 400, 'bad_request');
      return;
    }
    const { toolId, profileId } = body.data;
    // Resolve BEFORE gating — a malformed switch must never park a pending
    // confirmation the user would approve into an error (same as spawn).
    const adapter = deps.adapters.get(toolId);
    if (!adapter) {
      fail(res, 400, 'unknown_profile', { toolId, profileId });
      return;
    }
    if (profileId !== DEFAULT_PROFILE_ID) {
      if (!deps.registry.has(toolId, profileId)) {
        fail(res, 400, 'unknown_profile', { toolId, profileId });
        return;
      }
      const vars = adapter.configHomeEnvVars ?? [];
      if (vars.length === 0) {
        // No verified isolation env for this tool (e.g. agy) — honesty over a
        // switch that would silently keep using the real home.
        fail(res, 422, 'profile_unsupported', { toolId });
        return;
      }
    }
    await deps.gate(req, res, 'account.switch', {
      params: { toolId, profileId },
      execute: (actor) => {
        deps.registry.setActive(toolId, profileId);
        // Live sessions keep their old account until the USER restarts them —
        // the count is the honest warning; no restart, no signal.
        const liveSessionCount = deps.liveSessionCount(toolId);
        deps.store.append('account.profile_switched', {
          actor,
          tool: toolId,
          payload: { toolId, profileId, liveSessionCount },
        });
        const response: ProfileSwitchResponse = {
          switched: true,
          toolId,
          profileId,
          liveSessionCount,
        };
        return Promise.resolve({ status: 200, body: response });
      },
    });
  });
}
