/**
 * Pure close-code → notice policy for the terminal view (unit-testable — the
 * xterm component itself has no DOM test environment here).
 *
 * Label truth (M9 W7): a `closed_*` chip describes a DEAD link. It must clear
 * the moment a reconnect attaches successfully ({@link noticeAfterAttach}),
 * and reconnectable closes offer an explicit retry — the chip never sticks
 * past a live connection.
 */

export interface CloseOutcome {
  /** terminal.notice.* member to show (null = clean close, no chip). */
  notice: string | null;
  /** True when an rw attach must honestly downgrade to read-only (4403). */
  downgradeToRo: boolean;
}

/** Map a WS close code to the notice/downgrade outcome. */
export function closeNotice(code: number, mode: 'rw' | 'ro'): CloseOutcome {
  if (code === 1000) return { notice: null, downgradeToRo: false };
  if (code === 4403 && mode === 'rw') {
    // No user credential — honest downgrade to read-only, not a dead end.
    return { notice: 'user_required', downgradeToRo: true };
  }
  return { notice: `closed_${code}`, downgradeToRo: false };
}

/** Only closed_* chips describe a dead link and get the reconnect affordance. */
export function isReconnectableNotice(notice: string | null): boolean {
  return notice !== null && notice.startsWith('closed_');
}

/** Notice state after a SUCCESSFUL attach: stale closed_* chips are a lie. */
export function noticeAfterAttach(notice: string | null): string | null {
  return isReconnectableNotice(notice) ? null : notice;
}
