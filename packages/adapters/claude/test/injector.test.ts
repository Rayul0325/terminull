import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeHarnessInjector, HOOK_SPECS } from '../src/injector';

// SAFETY: every write test runs against a FAKE home under os.tmpdir(), never the
// real ~/.claude.
let home: string;
let claudeHome: string;
let injector: ClaudeHarnessInjector;
const ctx = {}; // claudeHome is fixed via options, so ctx.home is unused

const FOREIGN = `{
  "model": "sonnet",
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/opt/foreign/my-hook.sh"
          }
        ]
      }
    ]
  }
}
`;

function settingsPath(): string {
  return path.join(claudeHome, 'settings.json');
}
function readSettings(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
}
function hooksDir(): string {
  return path.join(claudeHome, 'terminull', 'hooks');
}
/** Count settings groups referencing our command for an event. */
function ourCount(event: string, file: string): number {
  const settings = readSettings();
  const hooks = (settings.hooks ?? {}) as Record<string, { hooks?: { command?: string }[] }[]>;
  const cmd = path.join(hooksDir(), file);
  return (hooks[event] ?? []).filter((g) => (g.hooks ?? []).some((h) => h.command === cmd)).length;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-claude-inj-'));
  claudeHome = path.join(home, '.claude');
  fs.mkdirSync(claudeHome, { recursive: true });
  injector = new ClaudeHarnessInjector({ claudeHome });
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('ClaudeHarnessInjector — install over foreign settings', () => {
  beforeEach(() => {
    fs.writeFileSync(settingsPath(), FOREIGN);
  });

  it('plan() lists the copies and the missing hook additions without touching disk', async () => {
    const plan = await injector.plan(ctx);
    expect(plan.willCopy.length).toBeGreaterThanOrEqual(HOOK_SPECS.length + 1); // +lib
    expect(plan.willAddHooks.map((h) => h.event)).toEqual(HOOK_SPECS.map((s) => s.event));
    // plan() must not have written anything.
    expect(fs.readFileSync(settingsPath(), 'utf8')).toBe(FOREIGN);
  });

  it('installs hooks, copies scripts, creates a backup, and verify() passes', async () => {
    const res = await injector.install(ctx);
    expect(res.installed).toBe(true);

    for (const spec of HOOK_SPECS) {
      expect(fs.existsSync(path.join(hooksDir(), spec.file))).toBe(true);
    }
    expect(fs.existsSync(path.join(hooksDir(), 'terminull-lib.sh'))).toBe(true);

    // Foreign hook still present; our 7 events added.
    expect(ourCount('SessionStart', 'terminull-session-start.sh')).toBe(1);
    const settings = readSettings();
    const ss = (settings.hooks as Record<string, unknown[]>).SessionStart;
    expect(JSON.stringify(ss)).toContain('/opt/foreign/my-hook.sh');

    // A backup was created.
    const backups = fs.readdirSync(claudeHome).filter((f) => f.includes('.terminull.bak-'));
    expect(backups.length).toBe(1);

    expect((await injector.verify(ctx)).installed).toBe(true);
    expect((await injector.status(ctx)).installed).toBe(true);
  });

  it('is idempotent — re-install adds no duplicate entries', async () => {
    await injector.install(ctx);
    await injector.install(ctx);
    for (const spec of HOOK_SPECS) {
      expect(ourCount(spec.event, spec.file)).toBe(1);
    }
  });

  it('uninstall restores settings.json BYTE-IDENTICALLY and removes our scripts', async () => {
    await injector.install(ctx);
    const res = await injector.uninstall(ctx);
    expect(res.installed).toBe(false);
    // Byte-identical to the original (foreign hook preserved byte-exact).
    expect(fs.readFileSync(settingsPath(), 'utf8')).toBe(FOREIGN);
    // Our scripts are gone.
    expect(fs.existsSync(hooksDir())).toBe(false);
    expect((await injector.verify(ctx)).installed).toBe(false);
  });
});

describe('ClaudeHarnessInjector — no pre-existing settings.json', () => {
  it('creates settings.json on install and removes it on uninstall', async () => {
    expect(fs.existsSync(settingsPath())).toBe(false);
    await injector.install(ctx);
    expect(fs.existsSync(settingsPath())).toBe(true);
    expect((await injector.status(ctx)).installed).toBe(true);

    await injector.uninstall(ctx);
    // Original was absent → restore = removed.
    expect(fs.existsSync(settingsPath())).toBe(false);
  });
});
