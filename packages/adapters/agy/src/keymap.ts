/**
 * The Antigravity (`agy`) keymap — raw terminal byte sequences for the keys an
 * interactive agy TUI session understands, each with an en+ko label and a risk
 * band.
 *
 * agy has no documented, adapter-classifiable prompt state (its screen cannot be
 * parsed the way Claude's numbered menus can — see `driver.ts`), so this keymap
 * is intentionally the tool-agnostic set: navigation + submit + interrupt +
 * draft-clear. Nothing here assumes an agy-specific screen shape.
 */
import type { Keymap } from '@terminull/adapter-sdk';

/** agy interactive key bindings. Sparse by design; only the safe common set. */
export const agyKeymap: Keymap = {
  Enter: {
    bytes: Uint8Array.from([0x0d]),
    tmuxName: 'Enter',
    label: { en: 'Enter (submit)', ko: '엔터 (전송)' },
    risk: 'low',
  },
  Escape: {
    bytes: Uint8Array.from([0x1b]),
    tmuxName: 'Escape',
    label: { en: 'Escape', ko: '이스케이프' },
    risk: 'low',
  },
  Tab: {
    bytes: Uint8Array.from([0x09]),
    tmuxName: 'Tab',
    label: { en: 'Tab', ko: '탭' },
    risk: 'low',
  },
  ShiftTab: {
    bytes: Uint8Array.from([0x1b, 0x5b, 0x5a]),
    tmuxName: 'BTab',
    label: { en: 'Shift + Tab', ko: '시프트 + 탭' },
    risk: 'low',
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
    bytes: Uint8Array.from([0x1b, 0x5b, 0x43]),
    tmuxName: 'Right',
    label: { en: 'Arrow Right', ko: '오른쪽 화살표' },
    risk: 'low',
  },
  Space: {
    bytes: Uint8Array.from([0x20]),
    tmuxName: 'Space',
    label: { en: 'Space', ko: '스페이스' },
    risk: 'low',
  },
  CtrlC: {
    bytes: Uint8Array.from([0x03]),
    tmuxName: 'C-c',
    quirks: ['sends SIGINT to the foreground process'],
    label: { en: 'Ctrl + C (interrupt)', ko: 'Ctrl + C (중단)' },
    risk: 'high',
  },
  CtrlU: {
    bytes: Uint8Array.from([0x15]),
    tmuxName: 'C-u',
    quirks: ['clears the current input line'],
    label: { en: 'Ctrl + U (clear line)', ko: 'Ctrl + U (줄 지우기)' },
    risk: 'med',
  },
};
