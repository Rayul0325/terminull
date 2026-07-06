/**
 * The Codex CLI keymap — raw terminal byte sequences for the keys Codex's TUI
 * understands, each with an en+ko label and a risk band.
 *
 * Codex's interrupt is Ctrl+C (unlike Claude, which interrupts on Escape): a
 * single Ctrl+C stops the current turn in the Codex TUI, a second quits. That
 * quirk is documented on the binding and honoured by the driver's `interrupt()`.
 */
import type { Keymap } from '@terminull/adapter-sdk';

/** Codex CLI key bindings. Sparse by design; only what the TUI honours. */
export const codexKeymap: Keymap = {
  Enter: {
    bytes: Uint8Array.from([0x0d]),
    tmuxName: 'Enter',
    label: { en: 'Enter (submit)', ko: '엔터 (전송)' },
    risk: 'low',
  },
  Escape: {
    bytes: Uint8Array.from([0x1b]),
    tmuxName: 'Escape',
    quirks: ['dismisses a Codex popup/approval prompt without accepting'],
    label: { en: 'Escape (dismiss)', ko: '이스케이프 (닫기)' },
    risk: 'low',
  },
  Tab: {
    bytes: Uint8Array.from([0x09]),
    tmuxName: 'Tab',
    label: { en: 'Tab (autocomplete)', ko: '탭 (자동완성)' },
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
    quirks: [
      'interrupts the current Codex turn (first press stops generation; a second press quits the TUI)',
    ],
    label: { en: 'Ctrl + C (interrupt)', ko: 'Ctrl + C (생성 중단)' },
    risk: 'high',
  },
  CtrlU: {
    bytes: Uint8Array.from([0x15]),
    tmuxName: 'C-u',
    quirks: ['clears the current input draft'],
    label: { en: 'Ctrl + U (clear draft)', ko: 'Ctrl + U (입력 지우기)' },
    risk: 'med',
  },
};
