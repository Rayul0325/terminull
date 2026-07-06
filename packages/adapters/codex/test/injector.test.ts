import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodexNotifyInjector, NOTIFY_SCRIPT, patchNotify, unpatchNotify } from '../src/injector';

// SAFETY: every write test runs against a FAKE home under os.tmpdir(), never the
// real ~/.codex.
let home: string;
let codexHome: string;
let injector: CodexNotifyInjector;
const ctx = {};

// A realistic config.toml: top-level keys, an existing notify line, and the
// per-project trust tables that MUST survive byte-identically.
const TRUST_BLOCK = `[projects."/Users/obogyo/secret-proj"]
trust_level = "trusted"

[projects."/Users/obogyo/other space"]
trust_level = "trusted"
`;
const WITH_NOTIFY = `model = "gpt-5-codex"
approval_policy = "on-request"
notify = ["/orig/notify-client", "turn-ended"]
sandbox_mode = "workspace-write"

${TRUST_BLOCK}`;
const WITHOUT_NOTIFY = `model = "gpt-5-codex"
approval_policy = "on-request"

${TRUST_BLOCK}`;

function configPath(): string {
  return path.join(codexHome, 'config.toml');
}
function scriptPath(): string {
  return path.join(codexHome, 'terminull', 'hooks', NOTIFY_SCRIPT);
}
function read(): string {
  return fs.readFileSync(configPath(), 'utf8');
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-codex-inj-'));
  codexHome = path.join(home, '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
  injector = new CodexNotifyInjector({ codexHome });
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('patchNotify / unpatchNotify (pure) — trust tables survive byte-identically', () => {
  it('prepends our wrapper and leaves the trust block byte-identical; unpatch is exact inverse', () => {
    const patched = patchNotify(WITH_NOTIFY, scriptPath());
    expect(patched.alreadyInstalled).toBe(false);
    expect(patched.addedLine).toBe(false);
    expect(patched.text).toContain(
      `notify = ["${scriptPath()}", "/orig/notify-client", "turn-ended"]`,
    );
    // The trust block is present, byte-for-byte.
    expect(patched.text).toContain(TRUST_BLOCK);
    // Exact inverse.
    expect(unpatchNotify(patched.text, scriptPath())).toBe(WITH_NOTIFY);
  });

  it('inserts a notify line before the first table when none exists; unpatch removes it exactly', () => {
    const patched = patchNotify(WITHOUT_NOTIFY, scriptPath());
    expect(patched.addedLine).toBe(true);
    expect(patched.text).toContain(`notify = ["${scriptPath()}"]`);
    // Inserted BEFORE the trust table, which survives byte-for-byte.
    expect(patched.text).toContain(TRUST_BLOCK);
    expect(patched.text.indexOf('notify =')).toBeLessThan(patched.text.indexOf('[projects.'));
    expect(unpatchNotify(patched.text, scriptPath())).toBe(WITHOUT_NOTIFY);
  });

  it('is idempotent — patching an already-wrapped config makes no change', () => {
    const once = patchNotify(WITH_NOTIFY, scriptPath());
    const twice = patchNotify(once.text, scriptPath());
    expect(twice.alreadyInstalled).toBe(true);
    expect(twice.text).toBe(once.text);
  });

  it('refuses a multi-line notify array rather than corrupt it', () => {
    const multi = `model = "x"\nnotify = [\n  "/orig/client",\n]\n${TRUST_BLOCK}`;
    const res = patchNotify(multi, scriptPath());
    expect(res.unsupported).toBeTruthy();
    expect(res.text).toBe(multi);
  });
});

describe('CodexNotifyInjector — install over a config with an existing notify + trust tables', () => {
  beforeEach(() => {
    fs.writeFileSync(configPath(), WITH_NOTIFY);
  });

  it('plan() previews the copies + prepend without touching disk', async () => {
    const plan = await injector.plan(ctx);
    expect(plan.willCopy.length).toBe(2); // notify script + shared lib
    expect(plan.addsNotifyLine).toBe(false);
    expect(read()).toBe(WITH_NOTIFY); // plan must not write
  });

  it('installs (prepends wrapper, copies scripts, backs up), trust block survives, verify passes', async () => {
    const res = await injector.install(ctx);
    expect(res.installed).toBe(true);

    // Scripts copied.
    expect(fs.existsSync(scriptPath())).toBe(true);
    expect(fs.existsSync(path.join(codexHome, 'terminull', 'hooks', 'terminull-lib.sh'))).toBe(
      true,
    );

    // Our wrapper is arg0; the original notify args are preserved after it.
    const after = read();
    expect(after).toContain(`notify = ["${scriptPath()}", "/orig/notify-client", "turn-ended"]`);
    // Trust tables byte-identical.
    expect(after).toContain(TRUST_BLOCK);

    // A backup was created.
    const backups = fs.readdirSync(codexHome).filter((f) => f.includes('.terminull.bak-'));
    expect(backups.length).toBe(1);
    expect(fs.readFileSync(path.join(codexHome, backups[0]!), 'utf8')).toBe(WITH_NOTIFY);

    expect((await injector.verify(ctx)).installed).toBe(true);
    expect((await injector.status(ctx)).installed).toBe(true);
  });

  it('is idempotent — re-install does not double-wrap', async () => {
    await injector.install(ctx);
    const once = read();
    await injector.install(ctx);
    expect(read()).toBe(once);
  });

  it('uninstall restores config.toml BYTE-IDENTICALLY and removes our scripts', async () => {
    await injector.install(ctx);
    const res = await injector.uninstall(ctx);
    expect(res.installed).toBe(false);
    expect(read()).toBe(WITH_NOTIFY); // byte-identical, trust tables intact
    expect(fs.existsSync(path.join(codexHome, 'terminull', 'hooks'))).toBe(false);
    expect((await injector.verify(ctx)).installed).toBe(false);
  });
});

describe('CodexNotifyInjector — install over a config with NO notify line', () => {
  beforeEach(() => {
    fs.writeFileSync(configPath(), WITHOUT_NOTIFY);
  });

  it('adds a notify line before the trust tables and restores byte-identically on uninstall', async () => {
    const res = await injector.install(ctx);
    expect(res.installed).toBe(true);
    const after = read();
    expect(after).toContain(`notify = ["${scriptPath()}"]`);
    expect(after).toContain(TRUST_BLOCK);

    await injector.uninstall(ctx);
    expect(read()).toBe(WITHOUT_NOTIFY);
  });
});

describe('CodexNotifyInjector — no pre-existing config.toml', () => {
  it('creates config.toml on install and removes our wrapper on uninstall', async () => {
    expect(fs.existsSync(configPath())).toBe(false);
    await injector.install(ctx);
    expect(fs.existsSync(configPath())).toBe(true);
    expect(read()).toContain(scriptPath());
    expect((await injector.status(ctx)).installed).toBe(true);

    await injector.uninstall(ctx);
    expect(read()).not.toContain(scriptPath());
    expect((await injector.status(ctx)).installed).toBe(false);
  });
});
