/**
 * Pending-confirmation queue — the server half of the `confirm` permission
 * class. When a gated action resolves to `confirm`, the fully-validated action
 * is captured as an execute closure and parked here; a `user` actor later
 * approves (runs it) or rejects (discards it) via /api/confirmations.
 *
 * Deliberately minimal but real: in-memory only (a queued closure cannot
 * survive a restart anyway), while the pending/approved/rejected EVENTS in the
 * store keep the durable audit trail.
 */
import crypto from 'node:crypto';
import type { RequestActor } from './auth.js';

/** The queued action's deferred outcome (an HTTP-shaped result). */
export interface GateResult {
  status: number;
  body: unknown;
}

/** One pending confirmation. */
export interface PendingConfirmation {
  id: string;
  action: string;
  /** Raw classification of the requester (may be 'unknown'). */
  actor: RequestActor;
  sessionId?: string;
  /** Machine-field summary shown to the approving user (already masked). */
  params: unknown;
  createdAt: number;
  execute: () => Promise<GateResult>;
}

export class ConfirmationQueue {
  private readonly pending = new Map<string, PendingConfirmation>();

  add(entry: Omit<PendingConfirmation, 'id' | 'createdAt'>): PendingConfirmation {
    const full: PendingConfirmation = {
      ...entry,
      id: crypto.randomUUID(),
      createdAt: Date.now(),
    };
    this.pending.set(full.id, full);
    return full;
  }

  get(id: string): PendingConfirmation | undefined {
    return this.pending.get(id);
  }

  remove(id: string): boolean {
    return this.pending.delete(id);
  }

  /** Serializable list for the UI (no closures). */
  list(): Array<Omit<PendingConfirmation, 'execute'>> {
    return [...this.pending.values()].map((p) => ({
      id: p.id,
      action: p.action,
      actor: p.actor,
      ...(p.sessionId !== undefined ? { sessionId: p.sessionId } : {}),
      params: p.params,
      createdAt: p.createdAt,
    }));
  }
}
