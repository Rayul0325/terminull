/**
 * REST/WS payload types for the panel server.
 *
 * Runtime imports come ONLY from `@terminull/shared` (the wire contract).
 * `@terminull/server` and `@terminull/adapter-sdk` are imported TYPE-ONLY —
 * erased at build time, so no backend code ever enters the browser bundle;
 * they exist to keep response shapes single-sourced with the server.
 */
import type { ChatItem } from '@terminull/adapter-sdk';
import type {
  AdapterFleetStatus,
  FleetSession,
  FleetSnapshot,
  GateResult,
  PendingConfirmation,
} from '@terminull/server';
import type { Envelope } from '@terminull/shared';

export type { AdapterFleetStatus, ChatItem, Envelope, FleetSession, FleetSnapshot };

/** `GET /api/health` */
export interface HealthResponse {
  ok: boolean;
  version: string;
  seq: number;
  sessions: { count: number; known: boolean };
  host: { connected: boolean };
  uptime: number;
}

/** `GET /api/events?since=` */
export interface EventsResponse {
  events: Envelope[];
  seq: number;
  /** True when events older than the server's in-memory window were lost. */
  gap: boolean;
}

/** `POST /api/directive` (200 delivered / 202 queued or pending confirmation) */
export interface DirectiveResponse {
  delivered?: boolean;
  queued?: boolean;
  directiveId?: string;
  /** Present when the permission gate parked the action for user approval. */
  code?: string;
  confirmationId?: string;
}

/** `POST /api/sessions` (201) */
export interface SpawnResponse {
  sessionId: string;
  sid: number;
  pid: number;
  label: string;
}

/** `GET /api/sessions/:sid/transcript` */
export type TranscriptResponse =
  | { supported: false; reason: string }
  | {
      supported: true;
      items: ChatItem[];
      cursor: { offset: number };
      done: boolean;
      truncatedHead?: boolean;
      droppedOlder?: boolean;
      reset?: boolean;
    };

/** `GET /api/confirmations` */
export interface ConfirmationsResponse {
  pending: Array<Omit<PendingConfirmation, 'execute'>>;
}

/** `POST /api/confirmations/:id/approve` */
export interface ApproveResponse {
  approved: boolean;
  confirmationId: string;
  action: string;
  resultStatus: GateResult['status'];
  result: unknown;
}
