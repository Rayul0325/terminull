/**
 * `terminull migrate --from control-tower` tests (M11).
 *
 * Fixtures REPLICATE this Mac's real legacy footprint (7 control-tower hooks in
 * settings.json — including one mixed into a multi-hook ExitPlanMode group and
 * two whole control-tower-only groups; a codex `ct-codex-notify.sh` wrapper; a
 * `com.rayul.control-tower` LaunchAgent plist alongside a foreign one; the
 * events.jsonl + state store) inside fake homes under `os.tmpdir()`. NOTHING
 * here touches the real `~/.claude/control-tower`, `~/.codex`, or
 * `~/Library/LaunchAgents`, and `launchctl` is always a recording fake.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { contentSha } from '@terminull/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type MigrateDeps,
  detectCodexNotify,
  detectLegacy,
  executeMigration,
  runMigrate,
} from './migrate';
import type { RunResult } from './service';

const tmpdirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-mig-'));
  tmpdirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tmpdirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const FIXED_NOW = 1_751_800_000_000; // deterministic archive stamp

/** A recording launchctl fake — never the real binary. */
function fakeLaunchctl(): {
  calls: string[][];
  run: (args: string[]) => Promise<RunResult>;
} {
  const calls: string[][] = [];
  return {
    calls,
    run: (args) => {
      calls.push(args);
      return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    },
  };
}

interface Sink {
  out: string[];
  err: string[];
}
function deps(home: string, launchctl = fakeLaunchctl().run, sink?: Sink): MigrateDeps {
  const s = sink ?? { out: [], err: [] };
  return {
    home,
    stateDir: path.join(home, '.terminull'),
    launchAgentsDir: path.join(home, 'Library', 'LaunchAgents'),
    launchctl,
    uid: 501,
    stdout: (l) => s.out.push(l),
    stderr: (l) => s.err.push(l),
    now: () => FIXED_NOW,
  };
}

// The codex notify wrapper installed by control-tower, and its original tail.
const ORIG_NOTIFY_CLIENT = '/Users/x/.codex/computer-use/SkyComputerUseClient';

/** Build the FULL legacy footprint under `home`. Returns key original paths. */
function seedFullFootprint(home: string): {
  settingsPath: string;
  settingsBytes: string;
  codexPath: string;
  codexBytes: string;
  plistPath: string;
  foreignPlistPath: string;
  stateDir: string;
  stateBytes: Record<string, Buffer>;
  ctHookCount: number;
} {
  const claude = path.join(home, '.claude');
  const ctHooks = path.join(claude, 'control-tower', 'hooks');
  fs.mkdirSync(ctHooks, { recursive: true });

  const ct = (f: string): string => path.join(ctHooks, f);
  const settings = {
    model: 'opus',
    hooks: {
      SessionStart: [
        {
          matcher: 'compact',
          hooks: [{ type: 'command', command: '~/.claude/hooks/compact-reanchor.sh' }],
        },
        { matcher: '*', hooks: [{ type: 'command', command: ct('ct-session-start.sh') }] },
      ],
      PostToolUse: [
        {
          matcher: 'ExitPlanMode',
          hooks: [
            { type: 'command', command: '~/.claude/hooks/artifact-local-guard.sh' },
            { type: 'command', command: '~/.claude/hooks/plan-preview.sh' },
            { type: 'command', command: ct('ct-plan-loop.sh') },
          ],
        },
      ],
      Notification: [{ matcher: '*', hooks: [{ type: 'command', command: ct('ct-notify.sh') }] }],
      Stop: [
        { matcher: '*', hooks: [{ type: 'command', command: '~/.claude/hooks/format-batch.sh' }] },
        { matcher: '*', hooks: [{ type: 'command', command: ct('ct-stop.sh') }] },
      ],
    },
  };
  const settingsPath = path.join(claude, 'settings.json');
  const settingsBytes = JSON.stringify(settings, null, 2) + '\n';
  fs.writeFileSync(settingsPath, settingsBytes);

  // codex config with the control-tower notify wrapper (+ a trust table to prove
  // byte-preservation of everything outside the notify line).
  const codexDir = path.join(home, '.codex');
  fs.mkdirSync(codexDir, { recursive: true });
  const codexPath = path.join(codexDir, 'config.toml');
  const codexBytes =
    'model = "gpt-5"\n\n' +
    `notify = ["${ct('ct-codex-notify.sh')}", "${ORIG_NOTIFY_CLIENT}", "turn-ended"]\n\n` +
    '[projects."/Users/x/work"]\ntrust_level = "trusted"\n';
  fs.writeFileSync(codexPath, codexBytes);

  // LaunchAgents: the control-tower plist + a foreign one that must be untouched.
  const laDir = path.join(home, 'Library', 'LaunchAgents');
  fs.mkdirSync(laDir, { recursive: true });
  const plistPath = path.join(laDir, 'com.rayul.control-tower.plist');
  fs.writeFileSync(
    plistPath,
    '<?xml version="1.0"?>\n<plist version="1.0"><dict>\n' +
      '  <key>Label</key>\n  <string>com.rayul.control-tower</string>\n' +
      '  <key>ProgramArguments</key>\n  <array>\n' +
      `    <string>/Users/x/.local/bin/node</string>\n    <string>${path.join(claude, 'control-tower', 'server', 'index.js')}</string>\n` +
      '  </array>\n</dict></plist>\n',
  );
  const foreignPlistPath = path.join(laDir, 'com.rayul.quizserver.plist');
  fs.writeFileSync(
    foreignPlistPath,
    '<?xml version="1.0"?>\n<plist version="1.0"><dict>\n  <key>Label</key>\n  <string>com.rayul.quizserver</string>\n</dict></plist>\n',
  );

  // events.jsonl + state store (token is a secret — seeded, never read/printed).
  const stateDir = path.join(claude, 'control-tower', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const stateBytes: Record<string, Buffer> = {
    'events.jsonl': Buffer.from('{"type":"session.start"}\n{"type":"session.end"}\n'),
    'constitution.json': Buffer.from('{"rules":[]}\n'),
    token: Buffer.from('tok_SECRET_do_not_read\n'),
  };
  for (const [name, buf] of Object.entries(stateBytes))
    fs.writeFileSync(path.join(stateDir, name), buf);

  return {
    settingsPath,
    settingsBytes,
    codexPath,
    codexBytes,
    plistPath,
    foreignPlistPath,
    stateDir,
    stateBytes,
    ctHookCount: 4,
  };
}

/** Collect every hook command in a settings.json, in (event → group → hook) order. */
function hookCommands(settingsPath: string): string[] {
  const obj = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as {
    hooks?: Record<string, { hooks?: { command?: string }[] }[]>;
  };
  const cmds: string[] = [];
  for (const groups of Object.values(obj.hooks ?? {})) {
    for (const g of groups) for (const h of g.hooks ?? []) if (h.command) cmds.push(h.command);
  }
  return cmds;
}

/** Run each printed rollback line via /bin/sh, with a no-op `launchctl` stub on PATH. */
function runRollback(lines: string[], home: string): void {
  const stub = path.join(home, 'stubbin');
  fs.mkdirSync(stub, { recursive: true });
  fs.writeFileSync(path.join(stub, 'launchctl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  for (const line of lines) {
    const r = spawnSync('/bin/sh', ['-c', line], {
      env: { ...process.env, PATH: `${stub}:/bin:/usr/bin` },
    });
    expect(r.status, `rollback line failed: ${line}\n${r.stderr}`).toBe(0);
  }
}

describe('detectLegacy + dry-run plan', () => {
  it('renders the full-footprint plan (dry run touches nothing)', async () => {
    const home = tmp();
    const seeded = seedFullFootprint(home);
    const sink: Sink = { out: [], err: [] };
    const code = await runMigrate({ from: 'control-tower' }, deps(home, fakeLaunchctl().run, sink));
    expect(code).toBe(0);

    // Home-relativized so the snapshot is machine-independent.
    const plan = sink.out.join('\n').split(home).join('<HOME>');
    expect(plan).toMatchInlineSnapshot(`
      "migrate --from control-tower (미리보기 — 아무것도 변경하지 않습니다)
        레거시 설치: <HOME>/.claude/control-tower

        항목                 / 위치 / 조치
        ─────────────────────────────────────────────
        Claude 훅 (settings.json)  <HOME>/.claude/settings.json
            → control-tower 훅 4개 제거, 나머지 훅은 보존 (먼저 백업)
            · SessionStart(*) → <HOME>/.claude/control-tower/hooks/ct-session-start.sh
            · PostToolUse(ExitPlanMode) → <HOME>/.claude/control-tower/hooks/ct-plan-loop.sh
            · Notification(*) → <HOME>/.claude/control-tower/hooks/ct-notify.sh
            · Stop(*) → <HOME>/.claude/control-tower/hooks/ct-stop.sh
        Codex notify (config.toml)    <HOME>/.codex/config.toml
            → codex notify를 control-tower 이전 값으로 복원 (먼저 백업)
        LaunchAgent 서비스            <HOME>/Library/LaunchAgents/com.rayul.control-tower.plist
            → launchctl bootout + plist 아카이브 (com.rayul.control-tower)
        이벤트/상태 저장소            <HOME>/.claude/control-tower/state
            → 상태 파일 3개 아카이브(이동) + sha manifest 기록
        ─────────────────────────────────────────────
        참고: control-tower 디렉터리는 그대로 둡니다 (<HOME>/.claude/control-tower) — 배선만 이관합니다 (병행 운영 가능)

      지금은 미리보기입니다. 실제 적용하려면 --execute 를 붙여 다시 실행하세요 (되돌리기 가능, 롤백 명령을 출력합니다)."
    `);

    // Dry run must not have modified anything.
    expect(fs.readFileSync(seeded.settingsPath, 'utf8')).toBe(seeded.settingsBytes);
    expect(fs.readFileSync(seeded.codexPath, 'utf8')).toBe(seeded.codexBytes);
    expect(fs.existsSync(seeded.plistPath)).toBe(true);
    expect(fs.existsSync(path.join(seeded.stateDir, 'events.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(home, '.terminull', 'migrate-archive'))).toBe(false);
  });

  it('detects the codex wrapper but NOT a plain (non-control-tower) notify', () => {
    const wrap =
      'notify = ["/Users/x/.claude/control-tower/hooks/ct-codex-notify.sh", "/Users/x/client", "turn-ended"]\n';
    expect(detectCodexNotify(wrap, '/x/config.toml')).not.toBeNull();

    const plain = `notify = ["${ORIG_NOTIFY_CLIENT}", "turn-ended"]\n`;
    expect(detectCodexNotify(plain, '/x/config.toml')).toBeNull();
  });

  it('ignores foreign LaunchAgents (only control-tower plists are found)', async () => {
    const home = tmp();
    seedFullFootprint(home);
    const fp = await detectLegacy(deps(home));
    expect(fp.launchAgents.map((a) => a.label)).toEqual(['com.rayul.control-tower']);
  });
});

describe('--execute round trip', () => {
  it('surgically migrates, preserves foreign hooks + trust table, and rolls back byte-exact', async () => {
    const home = tmp();
    const seeded = seedFullFootprint(home);
    const foreignBefore = hookCommands(seeded.settingsPath).filter(
      (c) => !c.includes('/control-tower/'),
    );
    const stateShas = Object.fromEntries(
      Object.entries(seeded.stateBytes).map(([n, b]) => [n, contentSha(b)]),
    );

    const lc = fakeLaunchctl();
    const fp = await detectLegacy(deps(home, lc.run));
    expect(fp.hooks?.hits.length).toBe(seeded.ctHookCount);
    const outcome = await executeMigration(fp, deps(home, lc.run));

    // (a) settings.json: control-tower hooks gone, EVERY foreign hook preserved.
    const afterCmds = hookCommands(seeded.settingsPath);
    expect(afterCmds.some((c) => c.includes('/control-tower/'))).toBe(false);
    expect(afterCmds).toEqual(foreignBefore);
    // ExitPlanMode group kept BOTH foreign hooks (mixed-group preservation).
    const after = JSON.parse(fs.readFileSync(seeded.settingsPath, 'utf8')) as {
      hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]>;
    };
    const planGroup = after.hooks.PostToolUse.find((g) => g.matcher === 'ExitPlanMode');
    expect(planGroup?.hooks.map((h) => h.command)).toEqual([
      '~/.claude/hooks/artifact-local-guard.sh',
      '~/.claude/hooks/plan-preview.sh',
    ]);
    // Notification (whole control-tower group) removed entirely.
    expect(after.hooks.Notification).toBeUndefined();

    // Backup captured the ORIGINAL bytes verbatim.
    expect(outcome.manifest.settings).toBeDefined();
    expect(fs.readFileSync(outcome.manifest.settings!.backup, 'utf8')).toBe(seeded.settingsBytes);

    // (b) codex notify: wrapper stripped, original tail + trust table preserved.
    const codexAfter = fs.readFileSync(seeded.codexPath, 'utf8');
    expect(codexAfter).toContain(`notify = ["${ORIG_NOTIFY_CLIENT}", "turn-ended"]`);
    expect(codexAfter).not.toContain('ct-codex-notify.sh');
    expect(codexAfter).toContain('[projects."/Users/x/work"]'); // byte-preserved table

    // (c) LaunchAgent: bootout target correct, plist archived, foreign one intact.
    expect(lc.calls).toEqual([['bootout', 'gui/501/com.rayul.control-tower']]);
    expect(fs.existsSync(seeded.plistPath)).toBe(false);
    const archivedPlist = outcome.manifest.launchAgents[0]!.archivedPath;
    expect(fs.existsSync(archivedPlist)).toBe(true);
    expect(fs.existsSync(seeded.foreignPlistPath)).toBe(true);

    // (d) state store: moved into the archive; manifest sha matches originals.
    expect(fs.existsSync(path.join(seeded.stateDir, 'events.jsonl'))).toBe(false);
    for (const m of outcome.manifest.stateArchive) {
      expect(fs.existsSync(m.to)).toBe(true);
      expect(m.sha).toBe(stateShas[path.basename(m.from)]);
    }
    expect(outcome.manifest.stateArchive.map((m) => path.basename(m.from)).sort()).toEqual([
      'constitution.json',
      'events.jsonl',
      'token',
    ]);
    // manifest.json exists on disk.
    expect(fs.existsSync(outcome.manifestPath)).toBe(true);

    // (e) ROLLBACK: run the exact printed commands → everything restored.
    runRollback(outcome.rollback, home);
    expect(fs.readFileSync(seeded.settingsPath, 'utf8')).toBe(seeded.settingsBytes); // byte-exact
    expect(fs.readFileSync(seeded.codexPath, 'utf8')).toBe(seeded.codexBytes); // byte-exact
    expect(fs.existsSync(seeded.plistPath)).toBe(true);
    for (const name of Object.keys(seeded.stateBytes)) {
      expect(fs.existsSync(path.join(seeded.stateDir, name))).toBe(true);
    }
    // After rollback the full footprint is detectable again.
    const refound = await detectLegacy(deps(home, lc.run));
    expect(refound.anyFound).toBe(true);
    expect(refound.hooks?.hits.length).toBe(seeded.ctHookCount);
  });

  it('is idempotent: a second execute finds nothing and exits 0', async () => {
    const home = tmp();
    seedFullFootprint(home);
    const lc = fakeLaunchctl();
    await runMigrate({ from: 'control-tower', execute: true }, deps(home, lc.run));

    const sink2: Sink = { out: [], err: [] };
    const lc2 = fakeLaunchctl();
    const code = await runMigrate(
      { from: 'control-tower', execute: true },
      deps(home, lc2.run, sink2),
    );
    expect(code).toBe(0);
    expect(sink2.out.join('\n')).toContain('migrate 대상 없음');
    expect(lc2.calls).toEqual([]); // nothing to bootout the second time
  });
});

describe('partial legacy states', () => {
  it('hooks-only: no plist / notify / state', async () => {
    const home = tmp();
    const claude = path.join(home, '.claude');
    const ctHooks = path.join(claude, 'control-tower', 'hooks');
    fs.mkdirSync(ctHooks, { recursive: true });
    const settingsPath = path.join(claude, 'settings.json');
    const bytes =
      JSON.stringify(
        {
          hooks: {
            Stop: [
              { matcher: '*', hooks: [{ type: 'command', command: '~/.claude/hooks/keep.sh' }] },
              {
                matcher: '*',
                hooks: [{ type: 'command', command: path.join(ctHooks, 'ct-stop.sh') }],
              },
            ],
          },
        },
        null,
        2,
      ) + '\n';
    fs.writeFileSync(settingsPath, bytes);

    const lc = fakeLaunchctl();
    const fp = await detectLegacy(deps(home, lc.run));
    expect(fp.hooks?.hits.length).toBe(1);
    expect(fp.launchAgents).toEqual([]);
    expect(fp.codexNotify).toBeNull();
    expect(fp.stateFiles.files).toEqual([]);

    const outcome = await executeMigration(fp, deps(home, lc.run));
    expect(hookCommands(settingsPath)).toEqual(['~/.claude/hooks/keep.sh']);
    expect(lc.calls).toEqual([]); // no launchctl call when no agent
    expect(outcome.manifest.launchAgents).toEqual([]);
    expect(outcome.manifest.stateArchive).toEqual([]);
    // rollback restores byte-exact.
    runRollback(outcome.rollback, home);
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(bytes);
  });

  it('service-only: plist present, no hooks/notify/state', async () => {
    const home = tmp();
    const laDir = path.join(home, 'Library', 'LaunchAgents');
    fs.mkdirSync(laDir, { recursive: true });
    const plistPath = path.join(laDir, 'com.rayul.control-tower.plist');
    fs.writeFileSync(
      plistPath,
      '<plist><dict><key>Label</key><string>com.rayul.control-tower</string>' +
        '<key>ProgramArguments</key><array><string>/x/.claude/control-tower/server/index.js</string></array></dict></plist>\n',
    );

    const lc = fakeLaunchctl();
    const fp = await detectLegacy(deps(home, lc.run));
    expect(fp.anyFound).toBe(true);
    expect(fp.hooks).toBeNull(); // no settings.json at all
    const outcome = await executeMigration(fp, deps(home, lc.run));
    expect(lc.calls).toEqual([['bootout', 'gui/501/com.rayul.control-tower']]);
    expect(fs.existsSync(plistPath)).toBe(false);
    runRollback(outcome.rollback, home);
    expect(fs.existsSync(plistPath)).toBe(true);
  });
});
