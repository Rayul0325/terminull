/**
 * The Claude Code keymap — raw terminal byte sequences for the keys Claude's
 * TUI understands, each with an en+ko label and a risk band.
 *
 * Two quirks are documented here and enforced by the driver's quirk engine
 * (see `driver.ts`), not by the bytes themselves:
 *  - ShiftTab (`ESC[Z`) cycles the permission mode. Claude's TUI drops the
 *    FIRST key after the pane has been idle, so a lone Shift+Tab is silently
 *    lost; the driver primes it with a `Right` (a no-op on an empty prompt)
 *    ~120 ms earlier. Source: control-tower index.js `/api/tmux-key` BTab path.
 *  - CtrlU clears any half-typed draft in the input box before text is injected,
 *    so a directive is never GLUED onto leftover draft text. Source:
 *    control-tower tmux.js `sendText` (live repro 2026-07-06).
 */
import type { Keymap } from '@terminull/adapter-sdk';

/** Byte sequence for `Right` — the ShiftTab priming key (also user-navigable). */
export const RIGHT_BYTES = Uint8Array.from([0x1b, 0x5b, 0x43]);
/** Delay after the priming key before the real key, in milliseconds. */
export const SHIFTTAB_PRIME_DELAY_MS = 120;

/** Claude Code key bindings. Sparse by design; only what the TUI honours. */
export const claudeKeymap: Keymap = {
  Enter: {
    bytes: Uint8Array.from([0x0d]),
    tmuxName: 'Enter',
    label: { en: 'Enter (submit)', ko: '엔터 (전송)' },
    risk: 'low',
  },
  Escape: {
    bytes: Uint8Array.from([0x1b]),
    tmuxName: 'Escape',
    quirks: ['interrupts the current generation (Claude stops the turn)'],
    label: { en: 'Escape (interrupt)', ko: '이스케이프 (생성 중단)' },
    risk: 'med',
  },
  Tab: {
    bytes: Uint8Array.from([0x09]),
    tmuxName: 'Tab',
    label: { en: 'Tab (autocomplete)', ko: '탭 (자동완성)' },
    risk: 'low',
  },
  ShiftTab: {
    bytes: Uint8Array.from([0x1b, 0x5b, 0x5a]),
    tmuxName: 'BTab',
    quirks: [
      'cycles the permission mode',
      'prime-first-key-after-idle: driver sends Right + ~120ms before this key (Claude drops the first post-idle key)',
    ],
    label: { en: 'Shift + Tab (cycle permission mode)', ko: '시프트 + 탭 (권한 모드 전환)' },
    risk: 'med',
  },
  Up: {
    bytes: Uint8Array.from([0x1b, 0x5b, 0x41]),
    tmuxName: 'Up',
    label: { en: 'Arrow Up', ko: '위쪽 화살표' },
    risk: 'low',
  },
  Down: {
    bytes: Uint8Array.from([0x1b, 0x5b, 0x42]),
    tmuxName: 'Down',
    label: { en: 'Arrow Down', ko: '아래쪽 화살표' },
    risk: 'low',
  },
  Left: {
    bytes: Uint8Array.from([0x1b, 0x5b, 0x44]),
    tmuxName: 'Left',
    label: { en: 'Arrow Left', ko: '왼쪽 화살표' },
    risk: 'low',
  },
  Right: {
    bytes: RIGHT_BYTES,
    tmuxName: 'Right',
    label: { en: 'Arrow Right', ko: '오른쪽 화살표' },
    risk: 'low',
  },
  Space: {
    bytes: Uint8Array.from([0x20]),
    tmuxName: 'Space',
    quirks: ['toggles a multi-select menu option'],
    label: { en: 'Space (toggle option)', ko: '스페이스 (선택 토글)' },
    risk: 'low',
  },
  CtrlC: {
    bytes: Uint8Array.from([0x03]),
    tmuxName: 'C-c',
    quirks: ['sends SIGINT — quits the TUI if the input line is already empty'],
    label: { en: 'Ctrl + C (quit)', ko: 'Ctrl + C (종료)' },
    risk: 'high',
  },
  CtrlU: {
    bytes: Uint8Array.from([0x15]),
    tmuxName: 'C-u',
    quirks: ['clears the current input draft'],
    label: { en: 'Ctrl + U (clear draft)', ko: 'Ctrl + U (입력 지우기)' },
    risk: 'med',
  },
  CtrlB: {
    bytes: Uint8Array.from([0x02]),
    tmuxName: 'C-b',
    quirks: ['backgrounds a running Bash tool call'],
    label: { en: 'Ctrl + B (background bash)', ko: 'Ctrl + B (배시 백그라운드)' },
    risk: 'low',
  },
};
