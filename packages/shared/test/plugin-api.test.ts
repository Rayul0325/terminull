import { describe, expect, it } from 'vitest';
import {
  ContributesSchema,
  LocalizedTextSchema,
  PLUGIN_API_VERSION,
  PluginManifestSchema,
} from '../src/index';

const validManifest = {
  name: 'terminull-plugin-x',
  version: '1.0.0',
  pluginApi: '^1',
  displayName: { en: 'Example', ko: '예시' },
  contributes: {
    adapters: [{ id: 'x', module: './x.js', displayName: { en: 'X', ko: '엑스' } }],
    keymaps: [{ id: 'k', module: './k.js', label: { en: 'Keys', ko: '키' } }],
  },
} as const;

describe('PLUGIN_API_VERSION', () => {
  it('is the integer major version', () => {
    expect(PLUGIN_API_VERSION).toBe(1);
  });
});

describe('LocalizedTextSchema — i18n en+ko rule', () => {
  it('accepts en+ko (and extra locales)', () => {
    expect(LocalizedTextSchema.safeParse({ en: 'Hi', ko: '안녕' }).success).toBe(true);
    expect(LocalizedTextSchema.safeParse({ en: 'Hi', ko: '안녕', ja: 'やあ' }).success).toBe(true);
  });

  it('rejects a label missing ko', () => {
    expect(LocalizedTextSchema.safeParse({ en: 'Hi' }).success).toBe(false);
  });

  it('rejects a label missing en', () => {
    expect(LocalizedTextSchema.safeParse({ ko: '안녕' }).success).toBe(false);
  });

  it('rejects empty locale strings', () => {
    expect(LocalizedTextSchema.safeParse({ en: '', ko: '안녕' }).success).toBe(false);
  });
});

describe('PluginManifestSchema', () => {
  it('parses a well-formed manifest', () => {
    expect(() => PluginManifestSchema.parse(validManifest)).not.toThrow();
  });

  it('fails when an adapter label is missing ko', () => {
    const bad = {
      ...validManifest,
      contributes: {
        adapters: [{ id: 'x', module: './x.js', displayName: { en: 'X' } }],
      },
    };
    expect(PluginManifestSchema.safeParse(bad).success).toBe(false);
  });

  it('fails when an adapter contribution omits its module', () => {
    const bad = {
      ...validManifest,
      contributes: { adapters: [{ id: 'x', displayName: { en: 'X', ko: '엑스' } }] },
    };
    expect(PluginManifestSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an unknown top-level manifest key (strict)', () => {
    expect(PluginManifestSchema.safeParse({ ...validManifest, rogue: true }).success).toBe(false);
  });
});

describe('ContributesSchema — strict', () => {
  it('accepts a known contribution point', () => {
    expect(ContributesSchema.safeParse({ commands: [] }).success).toBe(true);
  });

  it('rejects an unknown contribution key', () => {
    expect(
      ContributesSchema.safeParse({ adapters: [], bogusPoint: [{ id: 'z' }] }).success,
    ).toBe(false);
  });
});
