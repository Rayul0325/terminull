/**
 * Close-notice policy tests (M9 W7 — the sticky closed_1006 chip fix). The
 * truth rules: 1000 = clean close, no chip; 4403 on rw = honest read-only
 * downgrade; every other code = a closed_* chip that (a) offers reconnect and
 * (b) is CLEARED by a successful attach — a live connection never wears a
 * "connection lost" label.
 */
import { describe, expect, it } from 'vitest';
import ko from '../i18n/locales/ko.json';
import { closeNotice, isReconnectableNotice, noticeAfterAttach } from './closeNotice';

describe('closeNotice', () => {
  it('clean close (1000) shows no chip', () => {
    expect(closeNotice(1000, 'rw')).toEqual({ notice: null, downgradeToRo: false });
  });

  it('4403 on rw downgrades to read-only with the auth notice', () => {
    expect(closeNotice(4403, 'rw')).toEqual({ notice: 'user_required', downgradeToRo: true });
  });

  it('4403 on ro is just a closed chip (nothing to downgrade)', () => {
    expect(closeNotice(4403, 'ro')).toEqual({ notice: 'closed_4403', downgradeToRo: false });
  });

  it('an abnormal drop (1006) yields a localized, reconnectable chip', () => {
    const outcome = closeNotice(1006, 'rw');
    expect(outcome).toEqual({ notice: 'closed_1006', downgradeToRo: false });
    expect(isReconnectableNotice(outcome.notice)).toBe(true);
    // The chip is a real translation, not the raw fallback key.
    expect(ko.terminal.notice.closed_1006).toBeTypeOf('string');
  });

  it('only closed_* notices are reconnectable', () => {
    expect(isReconnectableNotice('user_required')).toBe(false);
    expect(isReconnectableNotice('read_only')).toBe(false);
    expect(isReconnectableNotice(null)).toBe(false);
    expect(isReconnectableNotice('closed_1011')).toBe(true);
  });

  it('a successful attach clears a stale closed_* chip but keeps auth notices', () => {
    expect(noticeAfterAttach('closed_1006')).toBeNull();
    expect(noticeAfterAttach('closed_1011')).toBeNull();
    expect(noticeAfterAttach('user_required')).toBe('user_required');
    expect(noticeAfterAttach(null)).toBeNull();
  });
});
