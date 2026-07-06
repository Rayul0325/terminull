/**
 * GUI statusbar ingest (M9 D5) — folds the LATEST `session.status` payload per
 * tool-native session id into an in-memory map and serves it as the REST seed
 * (`GET /api/sessions/:sid/status`).
 *
 * `session.status` is postable (forgeable by design): everything here is
 * display-only, nothing gates on it. Payloads are validated with the shared
 * schema — an invalid payload is DROPPED, never coerced into fake numbers.
 * No entry for a session = an honest `null` seed (codex/agy have no
 * statusline source in v1 and simply never appear here).
 */
import { SessionStatusDtoSchema, type SessionStatusDto } from '@terminull/shared';
import { Router, json } from './http-util.js';

/** Bound on tracked sessions — a forgeable ingress must not grow unbounded. */
const MAX_TRACKED_SESSIONS = 1000;

export class SessionStatusMap {
  /** Keyed by TOOL-NATIVE session id (the shim's only known id space). */
  private readonly byToolSessionId = new Map<string, SessionStatusDto>();

  /** Fold one posted payload; returns false when the payload was invalid. */
  ingest(payload: unknown): boolean {
    const parsed = SessionStatusDtoSchema.safeParse(payload);
    if (!parsed.success) return false; // dropped, never coerced
    const dto = parsed.data;
    // Latest-wins per session; re-inserting refreshes the eviction order.
    this.byToolSessionId.delete(dto.toolSessionId);
    this.byToolSessionId.set(dto.toolSessionId, dto);
    if (this.byToolSessionId.size > MAX_TRACKED_SESSIONS) {
      const oldest = this.byToolSessionId.keys().next().value;
      if (oldest !== undefined) this.byToolSessionId.delete(oldest);
    }
    return true;
  }

  /** The latest snapshot for a tool-native session id, or an honest null. */
  get(toolSessionId: string): SessionStatusDto | null {
    return this.byToolSessionId.get(toolSessionId) ?? null;
  }
}

/** Register `GET /api/sessions/:sid/status` (`:sid` = tool-native id). */
export function registerSessionStatusRoutes(r: Router, deps: { statuses: SessionStatusMap }): void {
  r.add('GET', '/api/sessions/:sid/status', (_req, res, params) => {
    json(res, 200, { status: deps.statuses.get(params['sid'] ?? '') });
  });
}
