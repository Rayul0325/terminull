/**
 * LocalizedText picker — adapter-supplied prose ships as {en, ko, ...} (the
 * plugin-api i18n rule); the web renders the current UI locale with an English
 * fallback. Server machine codes do NOT pass through here — they map to i18n
 * keys instead.
 */
import type { LocalizedText } from '@terminull/shared';

export function pickLocalized(text: LocalizedText | undefined, locale: string): string | undefined {
  if (!text) return undefined;
  const base = locale.split('-')[0] ?? locale;
  return text[base] ?? text['en'];
}
