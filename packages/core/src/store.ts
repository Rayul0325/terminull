/**
 * Event-sourced state store — TS port of the control-tower `Store`.
 *
 * Every mutation is an event with a store-assigned monotonic `seq`, appended
 * (synchronously) to `<stateDir>/events.jsonl`, folded into pure projections,
 * pushed onto a bounded in-memory inbox for `?since=` catch-up, and fanned out
 * to subscribers. Projections are pure and idempotent: replaying the log
 * reproduces identical state and appends NOTHING back to the file.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  EnvelopeSchema,
  isPostable,
  type Actor,
  type Envelope,
} from '@terminull/shared';

/** Default cap on the in-memory catch-up inbox (older events fall out). */
export const DEFAULT_MAX_INBOX = 500;

/** Options accepted by the {@link EventStore} constructor. */
export interface EventStoreOptions {
  /** Directory holding `events.jsonl` (created on load if absent). */
  stateDir: string;
  /** Cap on the in-memory inbox. Defaults to {@link DEFAULT_MAX_INBOX}. */
  maxInbox?: number;
  /** Machine label stamped on locally-minted events. Defaults to `'local'`. */
  machine?: string;
}

/** Everything an append may set beyond the store-assigned `seq`/`ts`/`type`. */
export interface AppendData {
  actor?: Actor;
  machine?: string;
  tool?: string;
  sessionId?: string;
  payload?: unknown;
  v?: 1;
}

/** A subscriber notified after each successful append. */
export type Subscriber = (ev: Envelope) => void;

/** Serialisable, order-stable view of the projections (for tests/audit). */
export interface ProjectionSnapshot {
  directives: Record<string, number[]>;
  asks: Record<string, number>;
  needsPermission: string[];
}

/** Thrown when a hook-facing append is given a non-postable (guarded) type. */
export class NotPostableError extends Error {
  readonly code = 'NOT_POSTABLE';
  constructor(type: string) {
    super(`event type "${type}" may not be posted by a session hook`);
    this.name = 'NotPostableError';
  }
}

/** Read a string field from an event's opaque payload, or undefined. */
function payloadString(ev: Envelope, key: string): string | undefined {
  const p = ev.payload;
  if (p && typeof p === 'object' && !Array.isArray(p)) {
    const val = (p as Record<string, unknown>)[key];
    if (typeof val === 'string') return val;
  }
  return undefined;
}

/** True when every line after `idx` is blank — i.e. `idx` is the last content. */
function isLastContentLine(lines: string[], idx: number): boolean {
  for (let j = idx + 1; j < lines.length; j++) {
    const later = lines[j];
    if (later && later.trim()) return false;
  }
  return true;
}

export class EventStore {
  readonly dir: string;
  readonly logFile: string;
  readonly maxInbox: number;
  readonly machine: string;

  seq = 0;
  /** Recent events kept in memory for `?since=` catch-up (bounded). */
  readonly inbox: Envelope[] = [];
  /** True only while replaying the log on load, so nothing self-appends. */
  replaying = false;

  // --- projections (pure views; never self-append) ---
  /** Pending directives per sessionId. */
  readonly directives = new Map<string, Envelope[]>();
  /** Open asks by askId. */
  readonly asks = new Map<string, Envelope>();
  /** Sessions currently awaiting a permission decision. */
  readonly needsPermission = new Set<string>();

  private readonly subscribers = new Set<Subscriber>();

  constructor(opts: EventStoreOptions) {
    this.dir = opts.stateDir;
    this.logFile = path.join(opts.stateDir, 'events.jsonl');
    this.maxInbox = opts.maxInbox ?? DEFAULT_MAX_INBOX;
    this.machine = opts.machine ?? 'local';
  }

  /**
   * Replay the on-disk log into memory. Tolerates a single torn final line (a
   * crash mid-append) by ignoring it; any earlier unparseable line is genuine
   * corruption and throws. Appends nothing back to the file.
   */
  load(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    if (!fs.existsSync(this.logFile)) return;
    const raw = fs.readFileSync(this.logFile, 'utf8');
    const lines = raw.split('\n');
    this.replaying = true;
    try {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line || !line.trim()) continue;
        let ev: Envelope;
        try {
          ev = JSON.parse(line) as Envelope;
        } catch {
          // Only a torn LAST line is tolerated; earlier garbage is real
          // corruption and must surface rather than be silently dropped.
          if (isLastContentLine(lines, i)) break;
          throw new Error(`corrupt event log: unparseable line ${i + 1}`);
        }
        this.seq = Math.max(this.seq, ev.seq ?? 0);
        this.applyProjection(ev);
        this.inbox.push(ev);
      }
    } finally {
      this.replaying = false;
    }
    if (this.inbox.length > this.maxInbox) {
      this.inbox.splice(0, this.inbox.length - this.maxInbox);
    }
  }

  /**
   * Append an event: assign seq/ts, validate the envelope, persist one JSON
   * line, fold projections, push the bounded inbox, and fan out to subscribers.
   * Refuses to run mid-replay (would corrupt determinism).
   */
  append(type: string, data: AppendData = {}): Envelope {
    if (this.replaying) {
      throw new Error('cannot append while replaying the event log');
    }
    const seq = this.seq + 1;
    const ev: Envelope = EnvelopeSchema.parse({
      seq,
      ts: Date.now(),
      v: data.v ?? 1,
      type,
      machine: data.machine ?? this.machine,
      tool: data.tool,
      sessionId: data.sessionId,
      actor: data.actor ?? 'system',
      payload: data.payload,
    });
    // Commit the seq only after validation succeeds, so a rejected event leaves
    // no gap in the sequence.
    this.seq = seq;
    fs.appendFileSync(this.logFile, JSON.stringify(ev) + '\n');
    this.applyProjection(ev);
    this.inbox.push(ev);
    if (this.inbox.length > this.maxInbox) this.inbox.shift();
    for (const fn of this.subscribers) {
      try {
        fn(ev);
      } catch {
        /* a subscriber bug must not break the append path */
      }
    }
    return ev;
  }

  /**
   * Hook-facing append: the forgery allowlist. Accepts only
   * `POSTABLE_EVENT_TYPES` (informational, forgeable by design) and rejects any
   * guarded/server-internal type. External events default to the `'hook'`
   * actor.
   */
  appendExternal(type: string, data: AppendData = {}): Envelope {
    if (!isPostable(type)) throw new NotPostableError(type);
    return this.append(type, { ...data, actor: data.actor ?? 'hook' });
  }

  /** Fold one event into the projections. Pure — never touches the file. */
  private applyProjection(ev: Envelope): void {
    switch (ev.type) {
      case 'directive.queued': {
        if (!ev.sessionId) break;
        if (!payloadString(ev, 'directiveId')) break;
        const q = this.directives.get(ev.sessionId) ?? [];
        q.push(ev);
        this.directives.set(ev.sessionId, q);
        break;
      }
      case 'directive.delivered':
      case 'directive.cancelled': {
        if (!ev.sessionId) break;
        const directiveId = payloadString(ev, 'directiveId');
        const q = this.directives.get(ev.sessionId) ?? [];
        this.directives.set(
          ev.sessionId,
          q.filter((d) => payloadString(d, 'directiveId') !== directiveId),
        );
        break;
      }
      case 'session.ask': {
        const askId = payloadString(ev, 'askId');
        if (askId) this.asks.set(askId, ev);
        break;
      }
      case 'ask.answered':
      case 'ask.expired': {
        const askId = payloadString(ev, 'askId');
        if (askId) this.asks.delete(askId);
        break;
      }
      // A session needs a permission decision until it makes any further move —
      // there is no explicit "granted" signal, so subsequent activity clears it.
      case 'session.needs_permission':
        if (ev.sessionId) this.needsPermission.add(ev.sessionId);
        break;
      case 'session.report':
      case 'session.activity':
      case 'session.idle':
      case 'session.start':
        if (ev.sessionId) this.needsPermission.delete(ev.sessionId);
        break;
      case 'session.end':
        // A session that ends can never emit ask.answered again, so its open
        // asks/permission would otherwise wedge forever. Clear both on end.
        if (ev.sessionId) {
          this.needsPermission.delete(ev.sessionId);
          for (const [aid, a] of this.asks) {
            if (a.sessionId === ev.sessionId) this.asks.delete(aid);
          }
        }
        break;
      default:
        break;
    }
  }

  /** Events in the inbox newer than `seq` (bounded by the inbox window). */
  eventsSince(seq: number): Envelope[] {
    return this.inbox.filter((e) => e.seq > seq);
  }

  /** Subscribe to appends; returns an unsubscribe function. */
  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  /** Order-stable, serialisable snapshot of the three projections. */
  projectionSnapshot(): ProjectionSnapshot {
    const directives: Record<string, number[]> = {};
    for (const sid of [...this.directives.keys()].sort()) {
      directives[sid] = (this.directives.get(sid) ?? []).map((e) => e.seq);
    }
    const asks: Record<string, number> = {};
    for (const aid of [...this.asks.keys()].sort()) {
      asks[aid] = this.asks.get(aid)!.seq;
    }
    return {
      directives,
      asks,
      needsPermission: [...this.needsPermission].sort(),
    };
  }
}
