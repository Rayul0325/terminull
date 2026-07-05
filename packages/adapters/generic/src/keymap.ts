/**
 * The generic PTY keymap — raw terminal byte sequences for the common keys any
 * interactive CLI understands. Every binding ships an en+ko label and a risk
 * band; nothing here assumes a specific tool.
 */
import type { Keymap } from '@terminull/adapter-sdk';

/** Common PTY key bindings shared by generic (tool-agnostic) sessions. */
export const genericKeymap: Keymap = {
  Enter: {
    bytes: Uint8Array.from([0x0d]),
    tmuxName: 'Enter',
    label: { en: 'Enter', ko: '엔터' },
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
  CtrlB: {
    bytes: Uint8Array.from([0x02]),
    tmuxName: 'C-b',
    quirks: ['tmux prefix key — may be intercepted when running inside tmux'],
    label: { en: 'Ctrl + B', ko: 'Ctrl + B' },
    risk: 'low',
  },
};
