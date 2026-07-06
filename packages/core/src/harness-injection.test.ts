/**
 * Injection-engine PRIMITIVE tests (M10 contract seeds) — these pin the two
 * golden-fixture behaviours the injection track builds on:
 *
 *  1. codex `config.toml`: a notify patch + unpatch around a realistic
 *     `[projects.*]` trust table is BYTE-IDENTICAL round-trip — the surgical
 *     line patch never reserializes the document.
 *  2. claude `settings.json`: existing user hooks survive an append in order
 *     and with values verbatim; re-running the same append is a no-op (dedup).
 *
 * Pure-function tests only (no fs); the InjectionEngine stub is pinned to
 * throw HarnessNotImplementedError until the injection track lands bodies.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ParseInvalidError, contentSha } from './harness-files.js';
import {
  InjectedLedgerSchema,
  InjectionAnchorError,
  InjectionEngine,
  type InjectedFileRecord,
  ejectInjectedFile,
  emptyInjectedLedger,
  injectedBackupDir,
  jsonArrayAppendDedup,
  minimalInsertedRun,
  tomlArrayLinePrepend,
  tomlArrayLineRemove,
  writeVerbatimBackup,
} from './harness-injection.js';

// --------------------------------------------------------------------------
// Golden fixture 1 — codex config.toml with a [projects.*] trust table
// --------------------------------------------------------------------------

const CODEX_GOLDEN = `# user's own comment — must survive untouched
model = "gpt-5.2-codex"
approval_policy = "on-request"
sandbox_mode   = "workspace-write"

[tools]
web_search = true

[projects."/Users/rayul/dev/my-app"]
trust_level = "trusted"

[projects."/Users/rayul/한글 프로젝트"]
trust_level = "trusted"
`;

const NOTIFY = '"/fake/state/terminull-codex-notify.sh"';

describe('tomlArrayLinePrepend / tomlArrayLineRemove (codex golden fixture)', () => {
  it('round-trips BYTE-IDENTICAL around the [projects.*] trust table (no notify line)', () => {
    const patched = tomlArrayLinePrepend(CODEX_GOLDEN, 'notify', NOTIFY);
    expect(patched.addedLine).toBe(true);
    expect(patched.alreadyPresent).toBe(false);
    // inserted before the FIRST table header — top-level keys must precede tables
    expect(patched.text.indexOf(`notify = [${NOTIFY}]`)).toBeLessThan(
      patched.text.indexOf('[tools]'),
    );
    // trust table bytes untouched even while patched
    expect(patched.text).toContain('[projects."/Users/rayul/한글 프로젝트"]');

    const restored = tomlArrayLineRemove(patched.text, 'notify', NOTIFY);
    expect(restored).toBe(CODEX_GOLDEN); // byte-identical
  });

  it('round-trips BYTE-IDENTICAL when the user already has a notify array', () => {
    const withUserNotify = `notify = ["afplay", "/System/Library/Sounds/Ping.aiff"]\n${CODEX_GOLDEN}`;
    const patched = tomlArrayLinePrepend(withUserNotify, 'notify', NOTIFY);
    expect(patched.addedLine).toBe(false);
    expect(patched.text).toContain(
      `notify = [${NOTIFY}, "afplay", "/System/Library/Sounds/Ping.aiff"]`,
    );

    const restored = tomlArrayLineRemove(patched.text, 'notify', NOTIFY);
    expect(restored).toBe(withUserNotify); // byte-identical
  });

  it('is idempotent: patching twice adds nothing, removing an absent element changes nothing', () => {
    const once = tomlArrayLinePrepend(CODEX_GOLDEN, 'notify', NOTIFY);
    const twice = tomlArrayLinePrepend(once.text, 'notify', NOTIFY);
    expect(twice.alreadyPresent).toBe(true);
    expect(twice.text).toBe(once.text);
    expect(tomlArrayLineRemove(CODEX_GOLDEN, 'notify', NOTIFY)).toBe(CODEX_GOLDEN);
  });

  it('REFUSES a multi-line array instead of corrupting it', () => {
    const multi = `notify = [\n  "say"\n]\n${CODEX_GOLDEN}`;
    const res = tomlArrayLinePrepend(multi, 'notify', NOTIFY);
    expect(res.unsupported).toMatch(/multi-line/);
    expect(res.text).toBe(multi); // untouched
  });
});

// --------------------------------------------------------------------------
// Golden fixture 2 — claude settings.json with existing user hooks
// --------------------------------------------------------------------------

const USER_HOOK = {
  matcher: '',
  hooks: [{ type: 'command', command: '/Users/rayul/bin/my-format.sh' }],
};
const OUR_HOOK = {
  matcher: '',
  hooks: [{ type: 'command', command: 'terminull hook session-start' }],
};
const sameByJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

describe('jsonArrayAppendDedup (claude golden fixture)', () => {
  const settings =
    JSON.stringify(
      {
        model: 'opus',
        permissions: { allow: ['Bash(ls:*)'] },
        hooks: { SessionStart: [USER_HOOK] },
      },
      null,
      2,
    ) + '\n';

  it('keeps existing user hooks in order and values verbatim; appends ours after', () => {
    const res = jsonArrayAppendDedup(settings, ['hooks', 'SessionStart'], [OUR_HOOK], sameByJson);
    expect(res.added).toEqual([OUR_HOOK]);
    const parsed = JSON.parse(res.text) as {
      model: string;
      permissions: unknown;
      hooks: { SessionStart: unknown[] };
    };
    expect(parsed.hooks.SessionStart).toEqual([USER_HOOK, OUR_HOOK]); // user first, ours appended
    expect(parsed.model).toBe('opus');
    expect(parsed.permissions).toEqual({ allow: ['Bash(ls:*)'] });
    // ledger fragment records the EXACT serialized bytes we added
    expect(res.addedBytes).toBe(JSON.stringify(OUR_HOOK, null, 2));
  });

  it('is a byte-level no-op when our hook is already present (dedup)', () => {
    const once = jsonArrayAppendDedup(settings, ['hooks', 'SessionStart'], [OUR_HOOK], sameByJson);
    const twice = jsonArrayAppendDedup(
      once.text,
      ['hooks', 'SessionStart'],
      [OUR_HOOK],
      sameByJson,
    );
    expect(twice.added).toEqual([]);
    expect(twice.text).toBe(once.text);
  });

  it('creates missing objects/arrays along the key path (absent file → {})', () => {
    const res = jsonArrayAppendDedup(null, ['hooks', 'SessionStart'], [OUR_HOOK], sameByJson);
    expect(JSON.parse(res.text)).toEqual({ hooks: { SessionStart: [OUR_HOOK] } });
  });

  it('throws typed errors: invalid JSON and non-appendable anchors', () => {
    expect(() => jsonArrayAppendDedup('{oops', ['hooks'], [1], sameByJson)).toThrow(
      ParseInvalidError,
    );
    expect(() =>
      jsonArrayAppendDedup(
        '{"hooks": "not-an-object"}',
        ['hooks', 'SessionStart'],
        [1],
        sameByJson,
      ),
    ).toThrow(InjectionAnchorError);
  });
});

// --------------------------------------------------------------------------
// Provenance ledger schema + engine stub pins
// --------------------------------------------------------------------------

describe('injected.json ledger schema', () => {
  it('accepts an empty ledger and a full record round-trip', () => {
    expect(InjectedLedgerSchema.parse(emptyInjectedLedger())).toEqual({ version: 1, tools: [] });
    const full = {
      version: 1 as const,
      tools: [
        {
          tool: 'codex',
          installedAt: 1751760000000,
          files: [
            {
              path: '/fake/home/.codex/config.toml',
              action: 'patched' as const,
              anchor: 'notify',
              addedBytes: `notify = [${NOTIFY}]\n`,
              shaBefore: 'a'.repeat(64),
              shaAfter: 'b'.repeat(64),
              backupPath: '/fake/state/backups/codex-config.toml.bak',
            },
          ],
        },
      ],
    };
    expect(InjectedLedgerSchema.parse(full)).toEqual(full);
  });

  it('rejects unknown keys (strict) and bad versions', () => {
    expect(InjectedLedgerSchema.safeParse({ version: 2, tools: [] }).success).toBe(false);
    expect(InjectedLedgerSchema.safeParse({ version: 1, tools: [], extra: true }).success).toBe(
      false,
    );
  });
});

// --------------------------------------------------------------------------
// minimalInsertedRun — the diff that makes drift-surgical eject byte-exact
// --------------------------------------------------------------------------

describe('minimalInsertedRun', () => {
  it('captures exactly the inserted contiguous run (single-line notify)', () => {
    const before = `[tools]\nweb_search = true\n`;
    const after = `notify = ["x"]\n[tools]\nweb_search = true\n`;
    const run = minimalInsertedRun(before, after);
    expect(run).toBe('notify = ["x"]\n');
    // removing the run verbatim restores `before` byte-for-byte
    expect(after.replace(run, '')).toBe(before);
  });

  it('captures a run whose verbatim removal restores the array (prepend case)', () => {
    const before = `notify = ["afplay"]\n`;
    const after = `notify = ["x", "afplay"]\n`;
    const run = minimalInsertedRun(before, after);
    // repeated quote chars make the exact split ambiguous, but ANY minimal run
    // must restore `before` when removed verbatim — that is the load-bearing property.
    expect(after.replace(run, '')).toBe(before);
  });
});

// --------------------------------------------------------------------------
// InjectionEngine — ledger round-trip, drift-respecting eject (gates b + c)
// --------------------------------------------------------------------------

describe('InjectionEngine (fake stateDir)', () => {
  let stateDir: string;
  let ledgerPath: string;
  let engine: InjectionEngine;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-inject-'));
    ledgerPath = path.join(stateDir, 'injected.json');
    engine = new InjectionEngine({ ledgerPath });
  });
  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('load() on an absent ledger returns the empty ledger', async () => {
    expect(await engine.load()).toEqual(emptyInjectedLedger());
    expect(await engine.status('claude')).toBeNull();
  });

  it('record() → load() round-trips exact bytes; re-record upserts (gate c)', async () => {
    const rec = {
      tool: 'codex',
      installedAt: 1751760000000,
      files: [
        {
          path: path.join(stateDir, 'config.toml'),
          action: 'patched' as const,
          anchor: 'notify',
          addedBytes: 'notify = ["x"]\n',
          shaBefore: 'a'.repeat(64),
          shaAfter: 'b'.repeat(64),
          backupPath: path.join(injectedBackupDir(stateDir), 'codex-config.toml-000000000000.bak'),
        },
      ],
    };
    await engine.record(rec);
    expect((await engine.load()).tools).toEqual([rec]);
    // the on-disk ledger is 0600 and schema-valid
    expect(fs.statSync(ledgerPath).mode & 0o777).toBe(0o600);
    // re-recording the same tool replaces (no duplicate)
    await engine.record({ ...rec, installedAt: 2 });
    const after = await engine.load();
    expect(after.tools).toHaveLength(1);
    expect(after.tools[0]?.installedAt).toBe(2);
  });

  it('eject restores a patched file BYTE-IDENTICAL when unedited (gate b)', async () => {
    const target = path.join(stateDir, 'settings.json');
    const original = JSON.stringify({ model: 'opus' }, null, 2) + '\n';
    fs.writeFileSync(target, original);
    const injected = JSON.stringify({ model: 'opus', hooks: {} }, null, 2) + '\n';
    const backupPath = await writeVerbatimBackup(stateDir, 'claude', target, original);
    fs.writeFileSync(target, injected);
    await engine.record({
      tool: 'claude',
      installedAt: 1,
      files: [
        {
          path: target,
          action: 'patched',
          anchor: 'hooks',
          addedBytes: minimalInsertedRun(original, injected),
          shaBefore: contentSha(original),
          shaAfter: contentSha(injected),
          backupPath,
        },
      ],
    });

    const report = await engine.eject('claude');
    expect(report.clean).toBe(true);
    expect(report.files[0]?.outcome).toBe('restored');
    expect(fs.readFileSync(target, 'utf8')).toBe(original); // byte-identical
    // clean eject drops the ledger entry
    expect(await engine.status('claude')).toBeNull();
  });

  it('eject unlinks a created file when unedited (removed)', async () => {
    const script = path.join(stateDir, 'hook.sh');
    fs.writeFileSync(script, '#!/bin/bash\n');
    await engine.record({
      tool: 'claude',
      installedAt: 1,
      files: [
        {
          path: script,
          action: 'created',
          anchor: 'script',
          addedBytes: null,
          shaBefore: null,
          shaAfter: contentSha('#!/bin/bash\n'),
          backupPath: null,
        },
      ],
    });
    const report = await engine.eject('claude');
    expect(report.files[0]?.outcome).toBe('removed');
    expect(fs.existsSync(script)).toBe(false);
  });

  it('eject drift on TOML with fragment intact → surgical strip', async () => {
    const target = path.join(stateDir, 'config.toml');
    const original = `[tools]\nweb_search = true\n`;
    const inserted = minimalInsertedRun(original, `notify = ["x"]\n${original}`);
    // user injected + then edited ELSEWHERE (added a comment) → drift
    const drifted = `notify = ["x"]\n# my new comment\n[tools]\nweb_search = true\n`;
    fs.writeFileSync(target, drifted);
    await engine.record({
      tool: 'codex',
      installedAt: 1,
      files: [
        {
          path: target,
          action: 'patched',
          anchor: 'notify',
          addedBytes: inserted,
          shaBefore: contentSha(original),
          shaAfter: contentSha(`notify = ["x"]\n${original}`),
          backupPath: await writeVerbatimBackup(stateDir, 'codex', target, original),
        },
      ],
    });
    const report = await engine.eject('codex');
    expect(report.files[0]?.outcome).toBe('surgical');
    expect(fs.readFileSync(target, 'utf8')).toBe('# my new comment\n[tools]\nweb_search = true\n');
    expect(report.clean).toBe(true);
  });

  it('eject drift with fragment GONE → warn + leave (gate b drift case)', async () => {
    const target = path.join(stateDir, 'config.toml');
    const userEdited = `model = "gpt-5"\n[tools]\nweb_search = false\n`;
    fs.writeFileSync(target, userEdited);
    await engine.record({
      tool: 'codex',
      installedAt: 1,
      files: [
        {
          path: target,
          action: 'patched',
          anchor: 'notify',
          addedBytes: 'notify = ["x"]\n',
          shaBefore: contentSha('orig'),
          shaAfter: contentSha('something-else-entirely'),
          backupPath: await writeVerbatimBackup(stateDir, 'codex', target, 'orig'),
        },
      ],
    });
    const report = await engine.eject('codex');
    expect(report.files[0]?.outcome).toBe('drift_left');
    expect(report.files[0]?.warning).toBeTruthy();
    expect(report.clean).toBe(false);
    expect(fs.readFileSync(target, 'utf8')).toBe(userEdited); // untouched
    // a non-clean eject KEEPS the ledger entry
    expect(await engine.status('codex')).not.toBeNull();
  });

  it('eject refuses a JSON strip that would break parsing → drift_left', async () => {
    const target = path.join(stateDir, 'settings.json');
    // our recorded addedBytes appears verbatim but stripping it invalidates JSON
    const content = '{"a":1,"frag":true}';
    fs.writeFileSync(target, content);
    const rec: InjectedFileRecord = {
      path: target,
      action: 'patched',
      anchor: 'x',
      addedBytes: ',"frag":true', // stripping leaves valid JSON, so craft a breaking one below
      shaBefore: contentSha('x'),
      shaAfter: contentSha('y'),
      backupPath: null,
    };
    // Craft a fragment whose removal breaks JSON: remove the closing brace region.
    const breaking: InjectedFileRecord = { ...rec, addedBytes: '1,"frag":true}' };
    const out = await ejectInjectedFile(breaking);
    expect(out.outcome).toBe('drift_left');
    expect(fs.readFileSync(target, 'utf8')).toBe(content); // untouched
  });

  it('eject missing file → missing', async () => {
    const out = await ejectInjectedFile({
      path: path.join(stateDir, 'gone.toml'),
      action: 'patched',
      anchor: 'notify',
      addedBytes: 'x',
      shaBefore: null,
      shaAfter: 'z',
      backupPath: null,
    });
    expect(out.outcome).toBe('missing');
  });
});
