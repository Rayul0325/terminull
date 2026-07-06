/**
 * Panel-server wire contract — the REST/WS shapes every client surface
 * (web, mobile, plugins, Manage-Agent) converges on.
 *
 * The server is the single source of truth: clients render seq-numbered
 * events streamed over `WS /ws` and resync any gap via
 * `GET /api/events?since=<seq>`. This module pins the message shapes so the
 * server and all clients share one schema (same rationale as host-protocol).
 */
import { z } from 'zod';
import { EnvelopeSchema } from './events.js';

/** Current panel-protocol major version (stamped in server.json + WS hello). */
export const PANEL_PROTO_VERSION = 1;

// ---------------------------------------------------------------------------
// WS /ws — server → client
// ---------------------------------------------------------------------------

/** First message on every `/ws` connection: the store's current seq. */
export const PanelHelloSchema = z
  .object({
    t: z.literal('hello'),
    proto: z.literal(1),
    /** Highest seq already persisted; a client behind this must REST-resync. */
    seq: z.number().int().nonnegative(),
  })
  .strict();
export type PanelHello = z.infer<typeof PanelHelloSchema>;

/** One live event, pushed after every append. */
export const PanelEventSchema = z.object({ t: z.literal('event'), event: EnvelopeSchema }).strict();
export type PanelEvent = z.infer<typeof PanelEventSchema>;

/** Every message the panel server sends on `/ws`. */
export const PanelServerMessageSchema = z.discriminatedUnion('t', [
  PanelHelloSchema,
  PanelEventSchema,
]);
export type PanelServerMessage = z.infer<typeof PanelServerMessageSchema>;

// ---------------------------------------------------------------------------
// WS /pty — client → server text control frames (binary frames are raw bytes)
// ---------------------------------------------------------------------------

/** Resize the attached PTY (read-write attachments only). */
export const PtyResizeSchema = z
  .object({
    t: z.literal('resize'),
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
  })
  .strict();
export type PtyResize = z.infer<typeof PtyResizeSchema>;

/** Every JSON text message a `/pty` client may send (binary = raw input). */
export const PtyClientMessageSchema = z.discriminatedUnion('t', [PtyResizeSchema]);
export type PtyClientMessage = z.infer<typeof PtyClientMessageSchema>;

/** Non-fatal error surfaced to a `/pty` client as a JSON text frame. */
export const PtyErrorSchema = z.object({ t: z.literal('error'), code: z.string().min(1) }).strict();
export type PtyError = z.infer<typeof PtyErrorSchema>;

/**
 * First text frame on a `/pty` connection: replay metadata from the daemon
 * attach (mirrors host-protocol `attached`). Binary frames that follow are raw
 * PTY output bytes.
 */
export const PtyAttachedSchema = z
  .object({
    t: z.literal('attached'),
    fromSeq: z.number().int().nonnegative(),
    headSeq: z.number().int().nonnegative(),
    gap: z.boolean(),
    readOnly: z.boolean(),
  })
  .strict();
export type PtyAttached = z.infer<typeof PtyAttachedSchema>;

// ---------------------------------------------------------------------------
// REST error body
// ---------------------------------------------------------------------------

/**
 * Machine-readable REST error: a stable `code` plus optional machine fields.
 * The server NEVER returns human prose — clients map `code` to i18n strings.
 */
export interface ApiError {
  code: string;
  [key: string]: unknown;
}

/** Schema for {@link ApiError} (extra machine fields allowed). */
export const ApiErrorSchema = z.object({ code: z.string().min(1) }).passthrough();
