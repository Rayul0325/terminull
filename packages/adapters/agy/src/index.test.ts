import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PluginHost, runAdapterConformance, type ToolAdapter } from '@terminull/adapter-sdk';
import * as adapterModule from './adapter';
import { createAgyAdapter } from './adapter';
import { parsePermissionModes, AGY_PERMISSION_MODES } from './capabilities';
import { manifest } from './manifest';

// A realistic `agy --help` fragment (agy prints usage to STDERR; the probe
// concatenates both streams, so the parser sees this either way).
const CANNED_HELP = `Usage of agy:
  --conversation                  Resume a previous conversation by ID
  --dangerously-skip-permissions  Auto-approve all tool permission requests without prompting
  -p                              Short alias for --print
  --print-timeout                 Timeout for print mode wait (default 5m0s)
  --sandbox                       Run in a sandbox with terminal restrictions enabled`;

/** The real agy binary if installed & executable, else null (tests skip). */
function realAgyPath(): string | null {
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'agy'),
    ...(process.env['PATH'] ?? '')
      .split(path.delimiter)
      .filter((d) => d.length > 0)
      .map((d) => path.join(d, 'agy')),
  ];
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {
      /* not here */
    }
  }
  return null;
}

let emptyHome: string;
beforeAll(() => {
  emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-agy-empty-'));
});
afterAll(() => {
  fs.rmSync(emptyHome, { recursive: true, force: true });
});

/** A hermetic adapter: injected help/version + an empty (nonexistent) gemini home. */
function hermeticAdapter(): ToolAdapter {
  return createAgyAdapter({
    runHelp: () => Promise.resolve(CANNED_HELP),
    runVersion: () => Promise.resolve('1.0.16'),
    geminiHome: path.join(emptyHome, '.gemini'),
  });
}

describe('parsePermissionModes', () => {
  it('derives modes from the --dangerously-skip-permissions and --sandbox flags (parsed-help)', () => {
    const res = parsePermissionModes(CANNED_HELP);
    expect(res.source).toBe('parsed-help');
    expect(res.modes).toEqual(['default', 'skip-permissions', 'sandbox']);
  });

  it('falls back to the builtin list tagged builtin-maybe-stale when unparseable', () => {
    for (const bad of [null, undefined, '', 'no recognizable flags here']) {
      const res = parsePermissionModes(bad);
      expect(res.source).toBe('builtin-maybe-stale');
      expect(res.modes).toEqual([...AGY_PERMISSION_MODES]);
    }
  });
});

describe('createAgyAdapter — honest capability matrix', () => {
  it('declares the minimal-plus agy matrix', () => {
    const a = hermeticAdapter();
    expect(a.id).toBe('agy');
    expect(a.capabilities.liveDetection).toBe('mtime-heuristic');
    expect(a.capabilities.transcript).toBe('opaque');
    expect(a.capabilities.headless).toBe('oneshot');
    expect(a.capabilities.acp).toBe(false);
    expect(a.capabilities.coDrive).toBe('none');
    expect(a.capabilities.hooks).toBe('none');
    expect(a.capabilities.modelDiscovery).toBe('configured');
    expect(a.capabilities.slashCommands).toBe('none');
    expect(a.capabilities.resume).toBe(true);
    expect(a.capabilities.fork).toBe(false);
    expect(a.capabilities.accounts).toEqual({
      whoami: true,
      usage: false,
      profiles: false,
      switch: false,
    });
    expect(a.capabilities.harnessFiles).toBe(true);
  });

  it('honestly ships NO transcript parser and NO harness injector', () => {
    const a = hermeticAdapter();
    // transcript is 'opaque' → there is intentionally no parser, and conformance
    // (below) must still pass with that combination.
    expect(a.capabilities.transcript).toBe('opaque');
    expect(a.parser).toBeUndefined();
    // hooks are 'none' → no injector.
    expect(a.capabilities.hooks).toBe('none');
    expect(a.injector).toBeUndefined();
  });

  it('exposes a driver, accounts, models and harness files', () => {
    const a = hermeticAdapter();
    expect(a.driverFor({ id: 's', tool: 'agy', live: false }, { inject: () => {} })).not.toBeNull();
    expect(a.accounts).toBeDefined();
    expect(a.models).toBeDefined();
    expect(a.harnessFiles?.length).toBeGreaterThan(0);
    expect(a.harnessFiles?.some((f) => f.id === 'agy.gemini.md')).toBe(true);
    expect(a.harnessFiles?.some((f) => f.id === 'agy.settings')).toBe(true);
  });
});

describe('createAgyAdapter — probe', () => {
  it('reports present + parsed permission modes + version (hermetic)', async () => {
    const a = hermeticAdapter();
    const res = await a.probe({ cmd: 'agy', which: () => '/usr/local/bin/agy' });
    expect(res.present).toBe(true);
    expect(res.version).toBe('1.0.16');
    expect(res.capabilities.permissionModes).toContain('default');
    expect(res.capabilities.permissionModes).toContain('skip-permissions');
    expect(res.capabilities.permissionModes).toContain('sandbox');
  });

  it('reports absent when the binary does not resolve', async () => {
    const a = hermeticAdapter();
    const res = await a.probe({ cmd: 'agy', which: () => null });
    expect(res.present).toBe(false);
  });

  // Real-binary probe: captures `agy --version` from the installed CLI. Offline
  // (only --help + --version are run). Skipped when agy is not installed.
  const realBin = realAgyPath();
  it.skipIf(!realBin)('probes the REAL agy binary and captures a semver version', async () => {
    const a = createAgyAdapter({ geminiHome: path.join(emptyHome, '.gemini') });
    const res = await a.probe({ cmd: 'agy', which: () => realBin });
    expect(res.present).toBe(true);
    expect(res.version).toMatch(/^\d+\.\d+\.\d+/);
    // The real --help lists both flags, so we expect the parsed set, not fallback.
    expect(res.capabilities.permissionModes).toContain('skip-permissions');
    expect(res.capabilities.permissionModes).toContain('sandbox');
  });
});

describe('dogfooding — agy registers through PluginHost and passes conformance', () => {
  const resolver = (p: string): unknown => (p === './adapter.js' ? adapterModule : undefined);

  it('registers cleanly and loads the adapter + keymap contribution', () => {
    const host = new PluginHost();
    const res = host.register(manifest, resolver);
    expect(res.ok).toBe(true);
    expect(res.adaptersRegistered).toBe(1);

    host.instantiateAll();
    expect(host.disabled()).toHaveLength(0);

    const lazy = host.adapters().get('agy');
    expect(lazy).toBeDefined();
    expect(lazy?.load().id).toBe('agy');
    expect(lazy?.displayName).toEqual({ en: 'Antigravity (agy)', ko: 'Antigravity (agy)' });
    expect(host.contributions('keymaps').some((c) => c.id === 'agy-default')).toBe(true);
  });

  it('the hermetic adapter passes the conformance runner (no parser, opaque transcript)', async () => {
    const result = await runAdapterConformance(hermeticAdapter(), {
      probeContext: { cmd: 'agy', which: () => '/usr/local/bin/agy' },
      collectContext: { home: emptyHome },
      // No `transcript` fixture: transcript is 'opaque', so there is no parser to
      // round-trip. Conformance must still pass.
      session: { id: 's1', tool: 'agy', live: false },
    });
    expect(result.failures).toHaveLength(0);
    expect(result.pass).toBe(true);
  });
});
