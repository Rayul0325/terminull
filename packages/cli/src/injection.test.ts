/**
 * CLI injection round-trip tests (gate (b) at the product layer): real adapters
 * inject into a FAKE home, provenance is recorded, and eject restores the
 * config file BYTE-IDENTICAL (or strips surgically under drift, or leaves a
 * user-drifted file with a warning). Never touches the real `~/.claude`/`~/.codex`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { INJECTED_LEDGER_FILE, InjectionEngine, injectedBackupDir } from '@terminull/core';
import { ejectTool, injectTool } from './injection';

const tmpdirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-cli-inj-'));
  tmpdirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tmpdirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function engineIn(stateDir: string): InjectionEngine {
  return new InjectionEngine({ ledgerPath: path.join(stateDir, INJECTED_LEDGER_FILE) });
}

const CODEX_CONFIG = `# my own comment
model = "gpt-5.2-codex"

[tools]
web_search = true

[projects."/Users/rayul/dev/app"]
trust_level = "trusted"

[projects."/Users/rayul/한글 프로젝트"]
trust_level = "trusted"
`;

describe('injectTool / ejectTool — codex config.toml (byte-identical + drift)', () => {
  it('records provenance, writes a verbatim backup, then eject restores byte-identical', async () => {
    const home = tmp();
    const stateDir = tmp();
    const codexHome = path.join(home, '.codex');
    fs.mkdirSync(codexHome, { recursive: true });
    const configPath = path.join(codexHome, 'config.toml');
    fs.writeFileSync(configPath, CODEX_CONFIG);
    const engine = engineIn(stateDir);

    const outcome = await injectTool('codex', { home, stateDir, engine });
    expect(outcome.status).toBe('injected');

    // ledger recorded the config (patched) + the scripts (created)
    const rec = await engine.status('codex');
    expect(rec).not.toBeNull();
    const configRec = rec?.files.find((f) => f.path === configPath);
    expect(configRec?.action).toBe('patched');
    expect(configRec?.backupPath).toBeTruthy();
    // a verbatim backup exists and equals the ORIGINAL bytes
    expect(fs.readFileSync(configRec!.backupPath!, 'utf8')).toBe(CODEX_CONFIG);
    expect(configRec!.backupPath!.startsWith(injectedBackupDir(stateDir))).toBe(true);
    // the trust table survived the patch byte-for-byte
    expect(fs.readFileSync(configPath, 'utf8')).toContain('[projects."/Users/rayul/한글 프로젝트"]');

    // second inject = idempotent no-op (ledger is SoT)
    expect((await injectTool('codex', { home, stateDir, engine })).status).toBe('already');

    const report = await ejectTool('codex', { home, engine });
    expect(report.clean).toBe(true);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(CODEX_CONFIG); // BYTE-IDENTICAL
    expect(await engine.status('codex')).toBeNull();
    // scripts + hooks dir removed
    expect(fs.existsSync(path.join(codexHome, 'terminull'))).toBe(false);
  });

  it('drift: user edits config.toml after inject → surgical strip keeps the edit', async () => {
    const home = tmp();
    const stateDir = tmp();
    const codexHome = path.join(home, '.codex');
    fs.mkdirSync(codexHome, { recursive: true });
    const configPath = path.join(codexHome, 'config.toml');
    fs.writeFileSync(configPath, CODEX_CONFIG);
    const engine = engineIn(stateDir);
    await injectTool('codex', { home, stateDir, engine });

    // user appends a NEW project trust entry after install
    const injected = fs.readFileSync(configPath, 'utf8');
    const drifted = injected + '\n[projects."/new/path"]\ntrust_level = "trusted"\n';
    fs.writeFileSync(configPath, drifted);

    const report = await ejectTool('codex', { home, engine });
    expect(report.clean).toBe(true);
    const after = fs.readFileSync(configPath, 'utf8');
    expect(after).not.toContain('terminull-codex-notify'); // our notify element gone
    expect(after).toContain('[projects."/new/path"]'); // user edit preserved
  });
});

describe('injectTool / ejectTool — claude settings.json byte-restore', () => {
  it('preserves a user hook, injects ours, then eject restores byte-identical', async () => {
    const home = tmp();
    const stateDir = tmp();
    const claudeHome = path.join(home, '.claude');
    fs.mkdirSync(claudeHome, { recursive: true });
    const settingsPath = path.join(claudeHome, 'settings.json');
    const original =
      JSON.stringify(
        {
          model: 'opus',
          hooks: {
            SessionStart: [
              { matcher: '', hooks: [{ type: 'command', command: '/Users/rayul/bin/mine.sh' }] },
            ],
          },
        },
        null,
        2,
      ) + '\n';
    fs.writeFileSync(settingsPath, original);
    const engine = engineIn(stateDir);

    const outcome = await injectTool('claude', { home, stateDir, engine });
    expect(outcome.status).toBe('injected');
    const injected = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as {
      hooks: { SessionStart: unknown[] };
    };
    // our hook was appended AFTER the user's
    expect(injected.hooks.SessionStart.length).toBeGreaterThan(1);

    const report = await ejectTool('claude', { home, engine });
    expect(report.clean).toBe(true);
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(original); // BYTE-IDENTICAL
    expect(await engine.status('claude')).toBeNull();
  });

  it('created-from-nothing settings.json is removed on eject', async () => {
    const home = tmp();
    const stateDir = tmp();
    const engine = engineIn(stateDir);
    await injectTool('claude', { home, stateDir, engine });
    const settingsPath = path.join(home, '.claude', 'settings.json');
    expect(fs.existsSync(settingsPath)).toBe(true);
    await ejectTool('claude', { home, engine });
    expect(fs.existsSync(settingsPath)).toBe(false); // we created it → removed
  });
});
