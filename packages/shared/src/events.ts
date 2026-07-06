/**
 * Event vocabulary and envelope schema shared across the monorepo.
 *
 * Every mutation in Terminull is an event with a server-assigned monotonic
 * `seq`, appended to an append-only log and folded into projections. This
 * module defines the on-wire envelope (validated with zod) and the split
 * between events a session hook may POST (`POSTABLE_EVENT_TYPES`, forgeable by
 * design) and events only the server may mint (`GUARDED_EVENT_TYPES`).
 */
import { z } from 'zod';

/** Who caused an event. Drives permission resolution downstream. */
export const ACTORS = ['user', 'agent', 'hook', 'system'] as const;
export type Actor = (typeof ACTORS)[number];

/**
 * The canonical event envelope. `seq`/`ts` are assigned by the store on append;
 * `payload` is intentionally opaque (`unknown`) — each event type documents its
 * own shape, kept out of this schema so the log stays forward-compatible.
 */
export const EnvelopeSchema = z
  .object({
    seq: z.number().int().nonnegative(),
    ts: z.number().int().nonnegative(),
    v: z.literal(1),
    type: z.string().min(1),
    machine: z.string().min(1),
    tool: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
    actor: z.enum(ACTORS),
    payload: z.unknown().optional(),
  })
  .strict();

export type Envelope = z.infer<typeof EnvelopeSchema>;

/**
 * Events a session hook is allowed to POST to the server. These are
 * hook-forgeable BY DESIGN — a hook reports what its session is doing and the
 * server trusts the report as informational only. Nothing security-bearing may
 * live here.
 */
export const POSTABLE_EVENT_TYPES = [
  'session.start',
  'session.activity',
  'session.report',
  'session.idle',
  'session.needs_permission',
  'session.ask',
  'session.turn',
  'session.end',
  // M9: statusline-shim telemetry (payload: SessionStatusDto). Display-only —
  // forgeable by design like every postable type; nothing gates on it.
  'session.status',
] as const;
export type PostableEventType = (typeof POSTABLE_EVENT_TYPES)[number];

/**
 * Server-internal events. They change authoritative state (asks, directives,
 * plans, permissions, hosts, board) and must NEVER be accepted from the open
 * POST endpoint — only minted by guarded server routes.
 */
export const GUARDED_EVENT_TYPES = [
  'ask.answered',
  'ask.expired',
  'directive.queued',
  'directive.delivered',
  'directive.cancelled',
  'plan.submitted',
  'plan.approved',
  'agent.state',
  'agent.action',
  'agent.speech',
  'permission.checked',
  'permission.settings_changed',
  'confirmation.pending',
  'confirmation.approved',
  'confirmation.rejected',
  'harness.edited',
  // M9 harness editor: payloads carry fileId/toolId/sha/backupId/bytes ONLY —
  // file content and diffs are NEVER persisted in the event log.
  'harness.file_written',
  'harness.file_restored',
  'account.profile_switched',
  // M9: server-persisted UI keybinding overrides changed (payload: action ids
  // touched, not combos — combos are prefs, not audit material).
  'prefs.keybindings_changed',
  'host.up',
  'host.down',
  'machine.state',
  'update.available',
  'board.card_created',
  'board.card_moved',
] as const;
export type GuardedEventType = (typeof GUARDED_EVENT_TYPES)[number];

/** Every known event type. */
export type EventType = PostableEventType | GuardedEventType;

const POSTABLE_SET: ReadonlySet<string> = new Set(POSTABLE_EVENT_TYPES);

/** True when a session hook may POST this event type (forgeable by design). */
export function isPostable(type: string): boolean {
  return POSTABLE_SET.has(type);
}
