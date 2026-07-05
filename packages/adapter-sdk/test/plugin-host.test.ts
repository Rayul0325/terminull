import { describe, expect, it } from 'vitest';
import type { AdapterFactory, ModuleResolver } from '../src/index';
import {
  PluginHost,
  minimalCapabilities,
  rangeSatisfies,
  type ToolAdapter,
} from '../src/index';

const label = { en: 'x', ko: 'x' };

function stubAdapter(id: string): ToolAdapter {
  return {
    id,
    displayName: { en: id, ko: id },
    capabilities: minimalCapabilities(),
    probe: () => Promise.resolve({ present: true, capabilities: {} }),
    collector: { collect: () => Promise.resolve([]) },
    driverFor: () => null,
    keymap: {},
    models: { list: () => Promise.resolve([]) },
  };
}

function stubFactory(id: string): AdapterFactory {
  return () => stubAdapter(id);
}

interface AdapterDecl {
  id: string;
  module: string;
}

function manifest(opts: { name?: string; pluginApi: string; adapters?: AdapterDecl[] }): unknown {
  return {
    name: opts.name ?? 'plugin',
    version: '0.0.0',
    pluginApi: opts.pluginApi,
    contributes: {
      adapters: (opts.adapters ?? []).map((a) => ({
        id: a.id,
        module: a.module,
        displayName: label,
      })),
    },
  };
}

/** Build a resolver from a module-path → factory map. */
function resolverFrom(map: Record<string, AdapterFactory>): ModuleResolver {
  return (p) => (p in map ? { createAdapter: map[p] } : undefined);
}

describe('rangeSatisfies', () => {
  it('accepts a caret range over the current major', () => {
    expect(rangeSatisfies('^1', 1)).toBe(true);
  });
  it('rejects a caret range over a different major', () => {
    expect(rangeSatisfies('^2', 1)).toBe(false);
  });
  it('accepts an exact version', () => {
    expect(rangeSatisfies('1', 1)).toBe(true);
    expect(rangeSatisfies('1.4.0', 1)).toBe(true);
  });
  it('accepts a comparator range', () => {
    expect(rangeSatisfies('>=1 <2', 1)).toBe(true);
    expect(rangeSatisfies('>=2 <3', 1)).toBe(false);
  });
  it('fails closed on garbage', () => {
    expect(rangeSatisfies('', 1)).toBe(false);
    expect(rangeSatisfies('latest', 1)).toBe(false);
  });
});

describe('PluginHost — semver gate', () => {
  it('loads a compatible plugin (^1)', () => {
    const host = new PluginHost();
    const res = host.register(
      manifest({ pluginApi: '^1', adapters: [{ id: 'a', module: './a.js' }] }),
      resolverFrom({ './a.js': stubFactory('a') }),
    );
    expect(res.ok).toBe(true);
    expect(res.adaptersRegistered).toBe(1);
    expect(host.adapters().has('a')).toBe(true);
    expect(host.disabled()).toHaveLength(0);
  });

  it('loads an exact-version plugin (1)', () => {
    const host = new PluginHost();
    const res = host.register(
      manifest({ pluginApi: '1', adapters: [{ id: 'a', module: './a.js' }] }),
      resolverFrom({ './a.js': stubFactory('a') }),
    );
    expect(res.ok).toBe(true);
    expect(host.adapters().has('a')).toBe(true);
  });

  it('disables an incompatible plugin (^2) with a reason — never throws', () => {
    const host = new PluginHost();
    let res: ReturnType<PluginHost['register']> | undefined;
    expect(() => {
      res = host.register(
        manifest({ name: 'future', pluginApi: '^2', adapters: [{ id: 'a', module: './a.js' }] }),
        resolverFrom({ './a.js': stubFactory('a') }),
      );
    }).not.toThrow();
    expect(res?.ok).toBe(false);
    expect(res?.reason).toMatch(/incompatible pluginApi/);
    expect(host.adapters().has('a')).toBe(false);
    expect(host.disabled().some((d) => d.name === 'future' && /incompatible/.test(d.reason))).toBe(
      true,
    );
  });

  it('disables a schema-invalid manifest with a reason', () => {
    const host = new PluginHost();
    const res = host.register({ name: 'broken' }, resolverFrom({}));
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/invalid manifest/);
    expect(host.disabled()).toHaveLength(1);
  });
});

describe('PluginHost — error isolation', () => {
  it('disables only the plugin whose adapter factory throws', () => {
    const host = new PluginHost();
    host.register(
      manifest({ name: 'good', pluginApi: '^1', adapters: [{ id: 'good', module: './good.js' }] }),
      resolverFrom({ './good.js': stubFactory('good') }),
    );
    host.register(
      manifest({ name: 'bad', pluginApi: '^1', adapters: [{ id: 'bad', module: './bad.js' }] }),
      resolverFrom({
        './bad.js': () => {
          throw new Error('boom during construction');
        },
      }),
    );

    // Lazy: nothing thrown yet. Instantiation isolates the failure.
    expect(() => host.instantiateAll()).not.toThrow();

    expect(host.adapters().has('bad')).toBe(false);
    expect(
      host.disabled().some((d) => d.id === 'bad' && /factory threw: boom/.test(d.reason)),
    ).toBe(true);

    // The good plugin is unaffected and still loads.
    const good = host.adapters().get('good');
    expect(good).toBeDefined();
    expect(good?.load().id).toBe('good');
  });

  it('disables an adapter whose module exports no factory', () => {
    const host = new PluginHost();
    const res = host.register(
      manifest({ pluginApi: '^1', adapters: [{ id: 'a', module: './a.js' }] }),
      () => ({ notAFactory: true }),
    );
    expect(res.adaptersRegistered).toBe(0);
    expect(res.contributionsDisabled.some((d) => /no adapter factory/.test(d.reason))).toBe(true);
  });
});

describe('PluginHost — deterministic dedup', () => {
  it('disables the second contribution sharing an adapter id (first wins)', () => {
    const host = new PluginHost();
    const res = host.register(
      manifest({
        pluginApi: '^1',
        adapters: [
          { id: 'dup', module: './a.js' },
          { id: 'dup', module: './b.js' },
        ],
      }),
      resolverFrom({ './a.js': stubFactory('dup'), './b.js': stubFactory('dup') }),
    );
    expect(res.adaptersRegistered).toBe(1);
    expect(res.contributionsDisabled).toHaveLength(1);
    expect(res.contributionsDisabled[0]?.reason).toMatch(/duplicate adapter id 'dup'/);
    expect(host.disabled().some((d) => d.id === 'dup')).toBe(true);
    // The first registration is the one kept.
    expect(host.adapters().get('dup')?.load().id).toBe('dup');
  });

  it('dedups across two plugins (later plugin loses)', () => {
    const host = new PluginHost();
    host.register(
      manifest({ name: 'first', pluginApi: '^1', adapters: [{ id: 'shared', module: './a.js' }] }),
      resolverFrom({ './a.js': stubFactory('shared') }),
    );
    const second = host.register(
      manifest({ name: 'second', pluginApi: '^1', adapters: [{ id: 'shared', module: './b.js' }] }),
      resolverFrom({ './b.js': stubFactory('shared') }),
    );
    expect(second.adaptersRegistered).toBe(0);
    expect(host.disabled().some((d) => d.name === 'second' && d.id === 'shared')).toBe(true);
  });
});
