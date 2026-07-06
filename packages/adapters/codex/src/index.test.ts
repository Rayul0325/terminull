import { fileURLToPath } from 'node:url';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PluginHost, runAdapterConformance, type ToolAdapter } from '@terminull/adapter-sdk';
import * as adapterModule from './adapter';
import { createCodexAdapter } from './adapter';
import { parsePermissionModes, BUILTIN_PERMISSION_MODES } from './capabilities';
import { manifest } from './manifest';

const GOLDEN = fileURLToPath(new URL('../test/fixtures/golden-rollout.jsonl', import.meta.url));

// A realistic `codex --help` fragment: the parser must lift the sandbox +
// approval tokens out of it.
const CANNED_HELP = `Usage: codex [options]
  -m, --model <MODEL>            Model for the session
  -s, --sandbox <SANDBOX_MODE>   Select the sandbox policy
          [possible values: read-only, workspace-write, danger-full-access]
  -a, --ask-for-approval <APPROVAL_POLICY>
          - untrusted: Only run trusted commands without asking
          - on-failure: Run all commands; ask on failure
          - on-request: The model decides when to ask
          - never:     Never ask for user approval`;

let emptyHome: string;
beforeAll(() => {
  emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-codex-empty-'));
});
afterAll(() => {
  fs.rmSync(emptyHome, { recursive: true, force: true });
});

/** A hermetic adapter: injected help + app-server + an empty codex home. */
function hermeticAdapter(): ToolAdapter {
  return createCodexAdapter({
    runHelp: () => Promise.resolve(CANNED_HELP),
    probeAppServer: () => Promise.resolve(true),
    codexHome: path.join(emptyHome, '.codex'),
  });
}

describe('parsePermissionModes', () => {
  it('parses sandbox + approval tokens out of help text (source parsed-help)', () => {
    const res = parsePermissionModes(CANNED_HELP);
    expect(res.source).toBe('parsed-help');
    expect(res.modes).toEqual([
      'read-only',
      'workspace-write',
      'danger-full-access',
      'untrusted',
      'on-failure',
      'on-request',
      'never',
    ]);
  });

  it('falls back to the builtin list tagged builtin-maybe-stale when unparseable', () => {
    for (const bad of [null, undefined, '', 'no options here']) {
      const res = parsePermissionModes(bad);
      expect(res.source).toBe('builtin-maybe-stale');
      expect(res.modes).toEqual([...BUILTIN_PERMISSION_MODES]);
    }
  });
});

describe('createCodexAdapter — capabilities & probe', () => {
  it('declares the honest Codex capability matrix', () => {
    const a = hermeticAdapter();
    expect(a.id).toBe('codex');
    expect(a.capabilities.liveDetection).toBe('mtime-heuristic');
    expect(a.capabilities.transcript).toBe('jsonl');
    expect(a.capabilities.headless).toBe('exec-json');
    expect(a.capabilities.acp).toBe(false);
    expect(a.capabilities.coDrive).toBe('none'); // conservative; probe upgrades it
    expect(a.capabilities.hooks).toBe('notify-only');
    expect(a.capabilities.modelDiscovery).toBe('configured');
    expect(a.capabilities.slashCommands).toBe('none');
    expect(a.capabilities.resume).toBe(true);
    expect(a.capabilities.fork).toBe(true);
    expect(a.capabilities.accounts).toEqual({
      whoami: false,
      usage: true,
      profiles: true,
      switch: false,
    });
    expect(a.capabilities.harnessFiles).toBe(true);
  });

  it('probe reports present + parsed permission modes + coDrive app-server when app-server exists', async () => {
    const a = hermeticAdapter();
    const res = await a.probe({ cmd: 'codex', which: () => '/usr/local/bin/codex' });
    expect(res.present).toBe(true);
    expect(res.capabilities.permissionModes).toContain('read-only');
    expect(res.capabilities.permissionModes).toContain('never');
    expect(res.capabilities.coDrive).toBe('app-server');
  });

  it('probe reports coDrive none when app-server is absent', async () => {
    const a = createCodexAdapter({
      runHelp: () => Promise.resolve(CANNED_HELP),
      probeAppServer: () => Promise.resolve(false),
      codexHome: path.join(emptyHome, '.codex'),
    });
    const res = await a.probe({ cmd: 'codex', which: () => '/usr/local/bin/codex' });
    expect(res.capabilities.coDrive).toBe('none');
  });

  it('probe reports absent when the binary does not resolve', async () => {
    const a = hermeticAdapter();
    const res = await a.probe({ cmd: 'codex', which: () => null });
    expect(res.present).toBe(false);
  });

  it('exposes a driver, injector, accounts and harness files', () => {
    const a = hermeticAdapter();
    expect(
      a.driverFor({ id: 's', tool: 'codex', live: false }, { inject: () => {} }),
    ).not.toBeNull();
    expect(a.injector).toBeDefined();
    expect(a.accounts).toBeDefined();
    expect(a.harnessFiles?.length).toBeGreaterThan(0);
  });
});

describe('dogfooding — codex registers through PluginHost and passes conformance', () => {
  const resolver = (p: string): unknown => (p === './adapter.js' ? adapterModule : undefined);

  it('registers cleanly and loads the adapter', () => {
    const host = new PluginHost();
    const res = host.register(manifest, resolver);
    expect(res.ok).toBe(true);
    expect(res.adaptersRegistered).toBe(1);

    host.instantiateAll();
    expect(host.disabled()).toHaveLength(0);

    const lazy = host.adapters().get('codex');
    expect(lazy?.load().id).toBe('codex');
    expect(host.contributions('keymaps').some((c) => c.id === 'codex-default')).toBe(true);
  });

  it('the hermetic adapter passes the conformance runner', async () => {
    const result = await runAdapterConformance(hermeticAdapter(), {
      probeContext: { cmd: 'codex', which: () => '/usr/local/bin/codex' },
      collectContext: { home: emptyHome },
      transcript: { ref: { kind: 'file', path: GOLDEN }, minItems: 4 },
      session: { id: 's1', tool: 'codex', live: false },
    });
    expect(result.failures).toHaveLength(0);
    expect(result.pass).toBe(true);
  });
});
