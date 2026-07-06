/**
 * Agent-approval inbox store — the pending confirmation cards the manage agent
 * originated (origin.kind === 'manage-agent'), seeded from GET
 * /api/agent/approvals and kept live from `confirmation.*` / `agent.action`
 * stream events (fed by src/stores/ingest.ts).
 *
 * Honesty contract: approve/deny puts a card into `resolving` — the outcome
 * turns green/red ONLY on the server's 200 (or the corresponding
 * confirmation.approved/rejected event). The confirmation queue is in-memory
 * server-side, so a 404 on resolve is a normal 'gone' state (restart), never
 * treated as success. The audit trail is exactly the `agent.action` events
 * this client received — no fabricated steps.
 */
import { create } from 'zustand';
import type {
  AgentActionPayload,
  AgentProposalOrigin,
  Envelope,
  PendingApprovalCard,
} from '@terminull/shared';
import { ApiHttpError, api } from '../api/client';

export type ApprovalEntryState = 'pending' | 'resolving' | 'approved' | 'rejected' | 'gone';

/** One observed audit-chain step (an `agent.action` event this client saw). */
export interface AuditTrailStep {
  phase: AgentActionPayload['phase'];
  ts: number;
  resultCode?: string;
}

export interface ApprovalEntry {
  card: PendingApprovalCard;
  state: ApprovalEntryState;
  /** The user's in-flight or applied decision. */
  decision?: 'approve' | 'reject';
  /** Machine code from a failed resolve attempt (card stays pending). */
  errorCode?: string;
  /** Execution outcome status from the approve response, when it ran. */
  resultStatus?: number;
  resolvedAt?: number;
  trail: AuditTrailStep[];
}

interface ApprovalsState {
  /** Insertion-ordered entries, pending and recently-resolved together. */
  entries: ApprovalEntry[];
  loading: boolean;
  errorCode: string | null;
  refresh(): Promise<void>;
  resolve(id: string, decision: 'approve' | 'reject'): Promise<void>;
  applyEvents(batch: Envelope[]): void;
}

/** Resolved-card history kept for outcome display (pending never trimmed). */
const MAX_RESOLVED = 30;

function payloadOf(ev: Envelope): Record<string, unknown> {
  const p = ev.payload;
  return p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
}

function originOf(payload: Record<string, unknown>): AgentProposalOrigin | undefined {
  const o = payload['origin'];
  if (o && typeof o === 'object' && (o as { kind?: unknown }).kind === 'manage-agent') {
    return o as AgentProposalOrigin;
  }
  return undefined;
}

function trimResolved(entries: ApprovalEntry[]): ApprovalEntry[] {
  const resolved = entries.filter((e) => e.state !== 'pending' && e.state !== 'resolving');
  if (resolved.length <= MAX_RESOLVED) return entries;
  const drop = new Set(resolved.slice(0, resolved.length - MAX_RESOLVED).map((e) => e.card.id));
  return entries.filter((e) => !drop.has(e.card.id));
}

export const useApprovalsStore = create<ApprovalsState>((set, get) => ({
  entries: [],
  loading: false,
  errorCode: null,

  refresh: async () => {
    if (get().loading) return;
    set({ loading: true });
    try {
      const res = await api.agentApprovals();
      const prev = get().entries;
      const byId = new Map(prev.map((e) => [e.card.id, e]));
      // Server list is authoritative for what is STILL pending; locally-known
      // resolved entries are kept for their outcome display.
      const pending: ApprovalEntry[] = res.pending.map((card) => {
        const existing = byId.get(card.id);
        return existing && existing.state !== 'gone'
          ? { ...existing, card }
          : { card, state: 'pending', trail: [] };
      });
      const pendingIds = new Set(res.pending.map((c) => c.id));
      const resolved = prev.filter(
        (e) => !pendingIds.has(e.card.id) && e.state !== 'pending' && e.state !== 'resolving',
      );
      set({ entries: trimResolved([...resolved, ...pending]), loading: false, errorCode: null });
    } catch (e) {
      const code = e instanceof ApiHttpError ? e.code : 'network';
      set({ loading: false, errorCode: code });
    }
  },

  resolve: async (id, decision) => {
    const entry = get().entries.find((e) => e.card.id === id);
    if (!entry || entry.state === 'resolving') return;
    if (entry.state !== 'pending') return; // already resolved/gone — no re-fire
    const update = (patch: Partial<ApprovalEntry>): void => {
      set({
        entries: get().entries.map((e) => (e.card.id === id ? { ...e, ...patch } : e)),
      });
    };
    // Optimistic PENDING state only — never an optimistic outcome.
    update({ state: 'resolving', decision, errorCode: undefined });
    try {
      const res = await api.resolveAgentApproval(id, decision);
      const resultStatus =
        'resultStatus' in res && typeof res.resultStatus === 'number'
          ? res.resultStatus
          : undefined;
      update({
        state: decision === 'approve' ? 'approved' : 'rejected',
        resolvedAt: Date.now(),
        ...(resultStatus !== undefined ? { resultStatus } : {}),
      });
      set({ entries: trimResolved(get().entries) });
    } catch (e) {
      if (e instanceof ApiHttpError && e.status === 404) {
        // In-memory queue lost the entry (server restart) — honest 'gone'.
        update({ state: 'gone', resolvedAt: Date.now() });
        return;
      }
      const code = e instanceof ApiHttpError ? e.code : 'network';
      // Back to pending: the card is still actionable, the failure visible.
      update({ state: 'pending', decision: undefined, errorCode: code });
    }
  },

  applyEvents: (batch) => {
    let entries = get().entries;
    let changed = false;
    for (const ev of batch) {
      const payload = payloadOf(ev);
      switch (ev.type) {
        case 'confirmation.pending': {
          const origin = originOf(payload);
          const id = payload['confirmationId'];
          // Inbox scope = agent-originated confirmations only; everything else
          // keeps flowing through the existing attention list untouched.
          if (!origin || typeof id !== 'string') break;
          if (entries.some((e) => e.card.id === id)) break;
          const card: PendingApprovalCard = {
            id,
            action: typeof payload['action'] === 'string' ? (payload['action'] as string) : '',
            actor: ev.actor,
            ...(ev.sessionId !== undefined ? { sessionId: ev.sessionId } : {}),
            params: payload['params'],
            createdAt: ev.ts,
            origin,
          };
          entries = [...entries, { card, state: 'pending', trail: [] }];
          changed = true;
          break;
        }
        case 'confirmation.approved':
        case 'confirmation.rejected': {
          const id = payload['confirmationId'];
          if (typeof id !== 'string') break;
          const outcome = ev.type === 'confirmation.approved' ? 'approved' : 'rejected';
          entries = entries.map((e) => {
            if (e.card.id !== id || (e.state !== 'pending' && e.state !== 'resolving')) return e;
            changed = true;
            return { ...e, state: outcome, resolvedAt: ev.ts };
          });
          break;
        }
        case 'agent.action': {
          const p = payload as Partial<AgentActionPayload>;
          if (typeof p.phase !== 'string' || typeof p.proposalId !== 'string') break;
          entries = entries.map((e) => {
            const matches =
              (p.confirmationId !== undefined && e.card.id === p.confirmationId) ||
              e.card.origin?.proposalId === p.proposalId;
            if (!matches) return e;
            changed = true;
            const step: AuditTrailStep = {
              phase: p.phase as AgentActionPayload['phase'],
              ts: ev.ts,
              ...(typeof p.resultCode === 'string' ? { resultCode: p.resultCode } : {}),
            };
            return { ...e, trail: [...e.trail, step] };
          });
          break;
        }
        default:
          break;
      }
    }
    if (changed) set({ entries: trimResolved(entries) });
  },
}));

/** Pending-only view (badge counts, home section). */
export function pendingApprovals(entries: ApprovalEntry[]): ApprovalEntry[] {
  return entries.filter((e) => e.state === 'pending' || e.state === 'resolving');
}
