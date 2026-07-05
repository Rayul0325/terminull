import { describe, expect, it } from 'vitest';
import en from './locales/en.json';
import ko from './locales/ko.json';
import { I18N_KEYS } from './keys';

/** Resolve a dotted key path (e.g. "app.title") against a nested object. */
function resolve(source: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((accumulator, part) => {
    if (accumulator && typeof accumulator === 'object' && part in accumulator) {
      return (accumulator as Record<string, unknown>)[part];
    }
    return undefined;
  }, source);
}

const locales: Record<string, unknown> = { ko, en };

describe('i18n locale parity', () => {
  for (const [name, bundle] of Object.entries(locales)) {
    it(`locale "${name}" defines every shared key as a string`, () => {
      for (const key of I18N_KEYS) {
        expect(resolve(bundle, key), `missing key "${key}" in "${name}"`).toBeTypeOf('string');
      }
    });
  }
});
