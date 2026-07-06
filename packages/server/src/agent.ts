/**
 * Manage-agent server glue — the pieces of the `/api/agent/*` surface that are
 * pure (no TerminullServer state): the default "unconfigured" brain, the
 * reverse permission map, the settings-DTO composer and small result helpers.
 *
 * The stateful half (the {@link PanelActions} executor with its audit chain)
 * lives in `app.ts` because it drives the same private action methods the
 * transport gate uses (`deliverDirective`, `spawnSession`, drivers).
 */
import { AGENT_ACTIONS, type PermissionSettings } from '@terminull/core';
import {
  PROPOSED_ACTION_PERMISSION,
  type PermissionSettingsDto,
  type ProposedActionKind,
} from '@terminull/shared';
import type { GateResult } from './confirmations.js';

/**
 * Reverse of {@link PROPOSED_ACTION_PERMISSION} (the map is 1:1 by contract,
 * asserted in the shared tests): core permission-action id → proposal kind.
 * Used to rebuild the `agent.action` audit payload at confirmation-resolve
 * time from the queue entry's `action` field alone.
 */
export const PERMISSION_TO_KIND: Readonly<Record<string, ProposedActionKind>> = Object.fromEntries(
  Object.entries(PROPOSED_ACTION_PERMISSION).map(([kind, permission]) => [permission, kind]),
) as Record<string, ProposedActionKind>;

/**
 * Compose the `GET /api/agent/permission-settings` response from the static
 * catalogue + the live settings. Classes are resolved (override + floor), so
 * the UI renders what will ACTUALLY be enforced.
 */
export function permissionSettingsDto(permissions: PermissionSettings): PermissionSettingsDto {
  return {
    version: 1,
    actions: AGENT_ACTIONS.map((def) => ({
      id: def.id,
      labelKey: def.labelKey,
      class: permissions.classOf(def.id),
      defaultClass: def.defaultClass,
      risk: def.risk,
      ...(def.floor !== undefined ? { floor: def.floor } : {}),
      requiresTwoStep: def.requiresTwoStep ?? false,
    })),
  };
}

/** Machine result code for an action's {@link GateResult} (audit field). */
export function resultCodeOf(result: GateResult): string {
  const body = result.body;
  if (body !== null && typeof body === 'object') {
    const code = (body as Record<string, unknown>)['code'];
    if (typeof code === 'string' && code.length > 0) return code;
  }
  return `http_${result.status}`;
}
