import { fileURLToPath } from 'node:url';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PluginHost, runAdapterConformance, type ToolAdapter } from '@terminull/adapter-sdk';
import * as adapterModule from './adapter';
import { createClaudeAdapter } from './adapter';
import { parsePermissionModes, BUILTIN_PERMISSION_MODES } from './capabilities';
import { manifest } from './manifest';

const GOLDEN = fileURLToPath(new URL('../test/fixtures/golden-session.jsonl', import.meta.url));

// A realistic `claude --help` fragment: the parser must lift these choices out.
const CANNED_HELP = `Usage: claude [options]
  --model <model>            Model for the current session
  --permission-mode <mode>   Permission mode to use for the session
                             (choices: "acceptEdits", "auto", "bypassPermissions",
                             "manual", "dontAsk", "plan")
  --safe-mode                Start with all customizations disabled`;

let emptyHome: string;
beforeAll(() => {
  emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-claude-empty-'));
});
afterAll(() => {
  fs.rmSync(emptyHome, { recursive: true, force: true });
});

/** A hermetic adapter: injected help + an empty (nonexistent) claude home. */
function hermeticAdapter(): ToolAdapter {
  return createClaudeAdapter({
    runHelp: () => Promise.resolve(CANNED_HELP),
    claudeHome: path.join(emptyHome, '.claude'),
  });
}

describe('parsePermissionModes', () => {
  it('parses the --permission-mode choices out of help text (source parsed-help)', () => {
    const res = parsePermissionModes(CANNED_HELP);
    expect(res.source).toBe('parsed-help');
    expect(res.modes).toEqual([
      'acceptEdits',
      'auto',
      'bypassPermissions',
      'manual',
      'dontAsk',
      'plan',
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

describe('createClaudeAdapter — capabilities & probe', () => {
  it('declares the honest Claude capability matrix', () => {
    const a = hermeticAdapter();
    expect(a.id).toBe('claude');
    expect(a.capabilities.liveDetection).toBe('pid-registry');
    expect(a.capabilities.transcript).toBe('jsonl');
    expect(a.capabilities.headless).toBe('stream-json');
    expect(a.capabilities.acp).toBe(false);
    expect(a.capabilities.coDrive).toBe('none');
    expect(a.capabilities.hooks).toBe('rich');
    expect(a.capabilities.modelDiscovery).toBe('dynamic');
    expect(a.capabilities.resume).toBe(true);
    expect(a.capabilities.fork).toBe(true);
    expect(a.capabilities.accounts).toEqual({
      whoami: true,
      usage: true,
      profiles: true,
      switch: false,
    });
    expect(a.capabilities.harnessFiles).toBe(true);
  });

  it('probe reports present + parsed permission modes when the binary resolves', async () => {
    const a = hermeticAdapter();
    const res = await a.probe({ cmd: 'claude', which: () => '/usr/local/bin/claude' });
    expect(res.present).toBe(true);
    expect(res.capabilities.permissionModes).toContain('plan');
    expect(res.capabilities.permissionModes).toContain('acceptEdits');
  });

  it('probe reports absent when the binary does not resolve', async () => {
    const a = hermeticAdapter();
    const res = await a.probe({ cmd: 'claude', which: () => null });
    expect(res.present).toBe(false);
  });

  it('exposes a driver, injector, accounts and harness files', () => {
    const a = hermeticAdapter();
    expect(
      a.driverFor({ id: 's', tool: 'claude', live: false }, { inject: () => {} }),
    ).not.toBeNull();
    expect(a.injector).toBeDefined();
    expect(a.accounts).toBeDefined();
    expect(a.harnessFiles?.length).toBeGreaterThan(0);
  });
});

describe('dogfooding — claude registers through PluginHost and passes conformance', () => {
  const resolver = (p: string): unknown => (p === './adapter.js' ? adapterModule : undefined);

  it('registers cleanly and loads the adapter', () => {
    const host = new PluginHost();
    const res = host.register(manifest, resolver);
    expect(res.ok).toBe(true);
    expect(res.adaptersRegistered).toBe(1);

    host.instantiateAll();
    expect(host.disabled()).toHaveLength(0);

    const lazy = host.adapters().get('claude');
    expect(lazy?.load().id).toBe('claude');
    expect(host.contributions('keymaps').some((c) => c.id === 'claude-default')).toBe(true);
  });

  it('the hermetic adapter passes the conformance runner', async () => {
    const result = await runAdapterConformance(hermeticAdapter(), {
      probeContext: { cmd: 'claude', which: () => '/usr/local/bin/claude' },
      collectContext: { home: emptyHome },
      transcript: { ref: { kind: 'file', path: GOLDEN }, minItems: 4 },
      session: { id: 's1', tool: 'claude', live: false },
    });
    expect(result.failures).toHaveLength(0);
    expect(result.pass).toBe(true);
  });
});
