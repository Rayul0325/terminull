/**
 * Server session registry — panel-server-side bookkeeping for paneld-owned
 * sessions. The daemon owns the PTYs; this registry maps a stable server id
 * (uuid, used in every public API) to the daemon `sid` plus the adapter that
 * spawned it. SpawnSpec.meta carries `{terminullId, adapterId, label, cwd}` so
 * the registry can be REBUILT from the daemon's `helloOk` session list after a
 * panel-server restart — the daemon, not this map, is the source of truth.
 */
import type { SessionSummary } from '@terminull/shared';

/** One paneld-owned session as the server tracks it. */
export interface ServerSession {
  /** Server-minted stable id (used in URLs, events, fleet). */
  id: string;
  /** Daemon session id (valid for the daemon's current boot only). */
  sid: number;
  adapterId: string;
  cwd: string;
  label: string;
  running: boolean;
  pid?: number;
  createdAt: number;
}

/** The meta block stamped into SpawnSpec.meta for later reconciliation. */
export interface SessionMeta {
  terminullId: string;
  adapterId: string;
  label: string;
  cwd: string;
  [key: string]: unknown;
}

function metaOf(summary: SessionSummary): SessionMeta | null {
  const m = summary.meta;
  if (!m || typeof m !== 'object') return null;
  const id = m['terminullId'];
  const adapterId = m['adapterId'];
  if (typeof id !== 'string' || typeof adapterId !== 'string') return null;
  return {
    terminullId: id,
    adapterId,
    label: typeof m['label'] === 'string' ? m['label'] : `${adapterId}-${summary.sid}`,
    cwd: typeof m['cwd'] === 'string' ? m['cwd'] : '',
  };
}

export class SessionRegistry {
  private readonly byId = new Map<string, ServerSession>();
  private readonly bySid = new Map<number, ServerSession>();

  add(session: ServerSession): void {
    this.byId.set(session.id, session);
    this.bySid.set(session.sid, session);
  }

  get(id: string): ServerSession | undefined {
    return this.byId.get(id);
  }

  getBySid(sid: number): ServerSession | undefined {
    return this.bySid.get(sid);
  }

  all(): ServerSession[] {
    return [...this.byId.values()];
  }

  /** Live (running) session count. */
  liveCount(): number {
    let n = 0;
    for (const s of this.byId.values()) if (s.running) n++;
    return n;
  }

  /** Mark a session exited. Returns it when the exit was a fresh transition. */
  markExited(sid: number): ServerSession | null {
    const s = this.bySid.get(sid);
    if (!s || !s.running) return null;
    s.running = false;
    return s;
  }

  /**
   * Reconcile against the daemon's advertised sessions after (re)connect.
   *
   *  - `resumed=true` (same daemon boot): sessions absent from the list died
   *    while we were away — mark them exited; sessions present get their
   *    running flag synced; unknown advertised sessions with terminull meta
   *    are re-adopted (panel-server restarted, daemon survived).
   *  - `resumed=false` (new daemon boot): every previously known session is
   *    dead (PTYs died with the old daemon) — mark all exited, then adopt
   *    whatever the fresh daemon advertises (normally nothing).
   *
   * Returns the sessions that TRANSITIONED to exited so the caller can mint
   * honest `session.end` events exactly once each.
   */
  reconcile(advertised: SessionSummary[], resumed: boolean): ServerSession[] {
    const ended: ServerSession[] = [];
    if (!resumed) {
      for (const s of this.byId.values()) {
        if (s.running) {
          s.running = false;
          ended.push(s);
        }
      }
      this.bySid.clear();
    }
    const seen = new Set<number>();
    for (const summary of advertised) {
      seen.add(summary.sid);
      const known = resumed ? this.bySid.get(summary.sid) : undefined;
      if (known) {
        if (known.running && !summary.running) {
          known.running = false;
          ended.push(known);
        } else {
          known.running = summary.running;
        }
        continue;
      }
      const meta = metaOf(summary);
      if (!meta) continue; // not one of ours (foreign client's session) — skip
      const existing = this.byId.get(meta.terminullId);
      const session: ServerSession = existing ?? {
        id: meta.terminullId,
        sid: summary.sid,
        adapterId: meta.adapterId,
        cwd: meta.cwd,
        label: meta.label,
        running: summary.running,
        ...(summary.pid !== undefined ? { pid: summary.pid } : {}),
        createdAt: Date.now(),
      };
      session.sid = summary.sid;
      session.running = summary.running;
      this.byId.set(session.id, session);
      this.bySid.set(summary.sid, session);
    }
    if (resumed) {
      for (const s of this.byId.values()) {
        if (s.running && !seen.has(s.sid)) {
          s.running = false;
          ended.push(s);
        }
      }
    }
    return ended;
  }
}
