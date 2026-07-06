/**
 * Agent-permission settings — simple, auditable per-action toggles.
 *
 * This is NOT a constitution: no proposals, amendments, or governance flow.
 * Each agent-initiated action resolves to one of three classes and every
 * check/set returns enough context for the caller to emit a
 * `permission.checked` / `permission.settings_changed` event. The module is
 * deliberately decoupled from the event store.
 *
 * Hard rules baked in:
 *  - `actor === 'user'` always resolves to `yes`.
 *  - An agent can NEVER change its own permissions (`set` throws for agents).
 *  - `session.delete` is floored at `confirm` for agents even if the settings
 *    file widens it, and always additionally requires the UI two-step.
 *  - Load is fail-closed: a missing/corrupt file (or bad entries) falls back to
 *    the safe built-in defaults, never to a more permissive state.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Actor } from '@terminull/shared';

/** How an action is gated. */
export type PermissionClass = 'autonomous' | 'confirm' | 'forbidden';
/** The resolved decision returned by {@link PermissionSettings.check}. */
export type PermissionDecision = 'yes' | 'confirm' | 'no';
/** Coarse risk band, surfaced in the UI. */
export type RiskLevel = 'low' | 'med' | 'high';

/** Static definition of one agent-initiated action. */
export interface AgentActionDef {
  /** Stable action id, e.g. `'directive.send'`. */
  id: string;
  /** i18n key for the human label, e.g. `'perm.directive_send'`. */
  labelKey: string;
  /** Class applied when the settings file has no override. */
  defaultClass: PermissionClass;
  /** Coarse risk band. */
  risk: RiskLevel;
  /**
   * Immutable minimum restrictiveness for agents. Even if the file widens the
   * action, resolution can never fall below this. Undefined = no floor.
   */
  floor?: PermissionClass;
  /**
   * When true, the action ALWAYS needs the UI two-step confirmation, on top of
   * whatever the permission class resolves to.
   */
  requiresTwoStep?: boolean;
}

/** The full, ordered action catalogue. */
export const AGENT_ACTIONS: readonly AgentActionDef[] = [
  {
    id: 'directive.send',
    labelKey: 'perm.directive_send',
    defaultClass: 'autonomous',
    risk: 'low',
  },
  { id: 'session.spawn', labelKey: 'perm.session_spawn', defaultClass: 'confirm', risk: 'med' },
  { id: 'ask.answer', labelKey: 'perm.ask_answer', defaultClass: 'forbidden', risk: 'high' },
  { id: 'plan.approve', labelKey: 'perm.plan_approve', defaultClass: 'forbidden', risk: 'high' },
  {
    id: 'permission.grant',
    labelKey: 'perm.permission_grant',
    defaultClass: 'forbidden',
    risk: 'high',
  },
  { id: 'permission.mode', labelKey: 'perm.permission_mode', defaultClass: 'confirm', risk: 'med' },
  {
    id: 'session.interrupt',
    labelKey: 'perm.session_interrupt',
    defaultClass: 'confirm',
    risk: 'med',
  },
  {
    id: 'session.delete',
    labelKey: 'perm.session_delete',
    defaultClass: 'confirm',
    risk: 'high',
    floor: 'confirm',
    requiresTwoStep: true,
  },
  { id: 'harness.edit', labelKey: 'perm.harness_edit', defaultClass: 'confirm', risk: 'high' },
  // M9 harness editor: file WRITES are separate from injector install/remove.
  // Danger-risk files (settings.json, config.toml — anything riskLevel 'high')
  // resolve through harness.write_danger, whose 'confirm' FLOOR is immutable:
  // an agent write can never bypass the confirmation queue even if the
  // settings file widens it (enforced server-side by action selection).
  { id: 'harness.write', labelKey: 'perm.harness_write', defaultClass: 'confirm', risk: 'med' },
  {
    id: 'harness.write_danger',
    labelKey: 'perm.harness_write_danger',
    defaultClass: 'confirm',
    risk: 'high',
    floor: 'confirm',
  },
  {
    id: 'account.switch',
    labelKey: 'perm.account_switch',
    defaultClass: 'forbidden',
    risk: 'high',
  },
  { id: 'board.edit', labelKey: 'perm.board_edit', defaultClass: 'autonomous', risk: 'low' },
];

const ACTION_BY_ID: ReadonlyMap<string, AgentActionDef> = new Map(
  AGENT_ACTIONS.map((a) => [a.id, a]),
);

/** Restrictiveness ordering: autonomous < confirm < forbidden. */
const RANK: Record<PermissionClass, number> = {
  autonomous: 0,
  confirm: 1,
  forbidden: 2,
};

function isPermissionClass(v: unknown): v is PermissionClass {
  return v === 'autonomous' || v === 'confirm' || v === 'forbidden';
}

/** The more restrictive of two classes (used to apply a floor). */
function atLeast(cls: PermissionClass, floor: PermissionClass): PermissionClass {
  return RANK[cls] >= RANK[floor] ? cls : floor;
}

function classToDecision(cls: PermissionClass): PermissionDecision {
  switch (cls) {
    case 'autonomous':
      return 'yes';
    case 'confirm':
      return 'confirm';
    case 'forbidden':
      return 'no';
  }
}

/** Result of a permission check — carries everything to build an audit event. */
export interface CheckResult {
  allowed: PermissionDecision;
  actionId: string;
  actor: Actor;
  /** The class after overrides + floor were applied. */
  resolvedClass: PermissionClass;
  /** Whether the UI two-step is additionally required. */
  requiresTwoStep: boolean;
}

/** Result of a successful set — carries the before/after for an audit event. */
export interface SetResult {
  actionId: string;
  previous: PermissionClass;
  next: PermissionClass;
  actor: Actor;
}

/** Thrown when an agent attempts to change permission settings. */
export class AgentPermissionMutationError extends Error {
  readonly code = 'AGENT_PERMISSION_MUTATION';
  constructor(actionId: string) {
    super(`agents may never change permission settings (action: ${actionId})`);
    this.name = 'AgentPermissionMutationError';
  }
}

/** Thrown when an unknown action id is referenced in a mutation. */
export class UnknownActionError extends Error {
  readonly code = 'UNKNOWN_ACTION';
  constructor(actionId: string) {
    super(`unknown agent action: ${actionId}`);
    this.name = 'UnknownActionError';
  }
}

/** Thrown when an invalid permission class is supplied to a mutation. */
export class InvalidPermissionClassError extends Error {
  readonly code = 'INVALID_PERMISSION_CLASS';
  constructor(value: unknown) {
    super(`invalid permission class: ${String(value)}`);
    this.name = 'InvalidPermissionClassError';
  }
}

/** On-disk shape of the settings file. */
interface SettingsFile {
  version: 1;
  actions: Record<string, PermissionClass>;
}

/**
 * Per-action permission overrides over the built-in defaults. Construct empty
 * for defaults, or via {@link PermissionSettings.load} to read a file
 * fail-closed.
 */
export class PermissionSettings {
  private readonly overrides = new Map<string, PermissionClass>();

  constructor(overrides?: Record<string, PermissionClass>) {
    if (overrides) {
      for (const [id, cls] of Object.entries(overrides)) {
        if (ACTION_BY_ID.has(id) && isPermissionClass(cls)) {
          this.overrides.set(id, cls);
        }
      }
    }
  }

  /**
   * Read settings from `file`, fail-closed: a missing file, corrupt JSON, or an
   * unusable shape all fall back to safe defaults. Individual bad entries
   * (unknown action id or invalid class) are dropped, not trusted.
   */
  static load(file: string): PermissionSettings {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      const actions = extractActions(parsed);
      return new PermissionSettings(actions);
    } catch {
      // Missing or corrupt → defaults (the safe baseline).
      return new PermissionSettings();
    }
  }

  /** The resolved class for an action from the agent's point of view. */
  private resolveClass(actionId: string, def: AgentActionDef): PermissionClass {
    const raw = this.overrides.get(actionId) ?? def.defaultClass;
    return def.floor ? atLeast(raw, def.floor) : raw;
  }

  /**
   * Resolve whether `actor` may perform `actionId`. `user` is always `yes`;
   * every other actor resolves against the settings + the action's floor.
   * Unknown actions fail closed (`no`).
   */
  check(actionId: string, actor: Actor): CheckResult {
    const def = ACTION_BY_ID.get(actionId);
    if (!def) {
      return {
        allowed: 'no',
        actionId,
        actor,
        resolvedClass: 'forbidden',
        requiresTwoStep: false,
      };
    }
    if (actor === 'user') {
      return {
        allowed: 'yes',
        actionId,
        actor,
        resolvedClass: 'autonomous',
        requiresTwoStep: def.requiresTwoStep ?? false,
      };
    }
    const resolvedClass = this.resolveClass(actionId, def);
    return {
      allowed: classToDecision(resolvedClass),
      actionId,
      actor,
      resolvedClass,
      requiresTwoStep: def.requiresTwoStep ?? false,
    };
  }

  /**
   * Set the class for an action. Refuses (throws) when the actor is an agent —
   * agents can never change their own permissions. Returns the before/after so
   * the caller can emit a `permission.settings_changed` event.
   */
  set(actionId: string, cls: PermissionClass, actor: Actor): SetResult {
    if (actor === 'agent') throw new AgentPermissionMutationError(actionId);
    const def = ACTION_BY_ID.get(actionId);
    if (!def) throw new UnknownActionError(actionId);
    if (!isPermissionClass(cls)) throw new InvalidPermissionClassError(cls);
    const previous = this.overrides.get(actionId) ?? def.defaultClass;
    this.overrides.set(actionId, cls);
    return { actionId, previous, next: cls, actor };
  }

  /** The current class for an action (override or default), floor-adjusted. */
  classOf(actionId: string): PermissionClass {
    const def = ACTION_BY_ID.get(actionId);
    if (!def) return 'forbidden';
    return this.resolveClass(actionId, def);
  }

  /** Serialisable snapshot of the explicit overrides. */
  toJSON(): SettingsFile {
    return { version: 1, actions: Object.fromEntries(this.overrides) };
  }

  /** Atomically persist to `file` (write temp, then rename). */
  save(file: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(this.toJSON(), null, 2));
    fs.renameSync(tmp, file);
  }
}

/** Pull a `{actionId: class}` map out of an unknown parsed settings blob. */
function extractActions(parsed: unknown): Record<string, PermissionClass> {
  if (!parsed || typeof parsed !== 'object') return {};
  // Support both `{version, actions:{...}}` and a bare `{actionId: class}` map.
  const container = 'actions' in parsed ? (parsed as { actions: unknown }).actions : parsed;
  if (!container || typeof container !== 'object') return {};
  const out: Record<string, PermissionClass> = {};
  for (const [id, cls] of Object.entries(container as Record<string, unknown>)) {
    if (isPermissionClass(cls)) out[id] = cls;
  }
  return out;
}
