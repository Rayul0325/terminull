/**
 * argv-surface tests for `terminull` — usage/exit codes plus one end-to-end
 * enroll→status→remove pass through runCli with fully faked side effects.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_PREAMBLE, MACHINES_FILE } from '@terminull/shared';
import { packDirToTarGz } from './bundle';
import { runCli, type CliDeps } from './cli';
import { AGENT_DIR } from './enroll-manifest';
import { LocalHomeSshRunner, ScriptedSshRunner } from './test-fakes';
import type { SshRunner } from './ssh-runner';

const tmpdirs: string[] = [];

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn8cli-c-'));
  tmpdirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpdirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface Capture {
  deps: CliDeps;
  out: string[];
  err: string[];
}

function makeDeps(runner?: SshRunner): Capture {
  const out: string[] = [];
  const err: string[] = [];
  const bundleDir = tmp();
  fs.mkdirSync(path.join(bundleDir, 'dist'), { recursive: true });
  fs.writeFileSync(
    path.join(bundleDir, 'dist', 'bin.js'),
    `if (process.argv.includes('--probe')) { process.stdout.write('${AGENT_PREAMBLE}\\n'); process.exit(0); }\nprocess.exit(1);\n`,
  );
  const deps: CliDeps = {
    enrollDeps: {
      runner: runner ?? new ScriptedSshRunner([]),
      buildBundle: () => packDirToTarGz(bundleDir),
      log: (line) => out.push(line),
    },
    fetchImpl: fetch,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    defaultServerState: tmp(), // NEVER the real ~/.terminull in tests
  };
  return { deps, out, err };
}

describe('runCli usage surface', () => {
  it('no arguments → usage on stderr, exit 2', async () => {
    const { deps, err } = makeDeps();
    expect(await runCli([], deps)).toBe(2);
    expect(err.join('\n')).toContain('terminull enroll <ssh-host>');
  });

  it('--help → usage on stdout, exit 0', async () => {
    const { deps, out } = makeDeps();
    expect(await runCli(['--help'], deps)).toBe(0);
    expect(out.join('\n')).toContain('terminull machines');
  });

  it('unknown command → exit 2', async () => {
    const { deps } = makeDeps();
    expect(await runCli(['frobnicate'], deps)).toBe(2);
  });

  it('enroll without a host → exit 2', async () => {
    const { deps } = makeDeps();
    expect(await runCli(['enroll'], deps)).toBe(2);
  });

  it('machines with an unknown subcommand → exit 2', async () => {
    const { deps } = makeDeps();
    expect(await runCli(['machines', 'bogus'], deps)).toBe(2);
  });

  it('unknown flag → exit 2', async () => {
    const { deps } = makeDeps();
    expect(await runCli(['machines', '--bogus'], deps)).toBe(2);
  });
});

describe('runCli end-to-end (fake remote home)', () => {
  it('enroll → machines status → enroll --remove round trip', async () => {
    const home = tmp();
    const state = tmp();
    const runner = new LocalHomeSshRunner(home, 'mars');

    // enroll
    const enrollRun = makeDeps(runner);
    const code = await runCli(
      ['enroll', 'mars', '--id', 'mars', '--label', 'Mars', '--server-state', state],
      enrollRun.deps,
    );
    expect(code).toBe(0);
    const enrollOut = enrollRun.out.join('\n');
    expect(enrollOut).toContain('등록 완료: mars (mars)');
    expect(enrollOut).toContain('"kind": "ssh"'); // printed machine entry
    expect(enrollOut).toContain('서버 자동 갱신 실패'); // no server → honest hint
    expect(fs.existsSync(path.join(state, MACHINES_FILE))).toBe(true);
    expect(fs.existsSync(path.join(home, AGENT_DIR, 'VERSION'))).toBe(true);

    // machines status (server down → honest config-only)
    const statusRun = makeDeps(runner);
    expect(await runCli(['machines', 'status', '--server-state', state], statusRun.deps)).toBe(0);
    const statusOut = statusRun.out.join('\n');
    expect(statusOut).toContain('서버가 실행 중이 아닙니다');
    expect(statusOut).toContain('mars');
    expect(statusOut).toContain('설정만');

    // enroll --remove: full reversal with printed proof
    const removeRun = makeDeps(runner);
    expect(
      await runCli(['enroll', '--remove', 'mars', '--server-state', state], removeRun.deps),
    ).toBe(0);
    const removeOut = removeRun.out.join('\n');
    expect(removeOut).toContain('.terminull-agent 를 제거했습니다');
    expect(removeOut).toContain('머신 mars 등록을');
    expect(fs.existsSync(path.join(home, AGENT_DIR))).toBe(false);

    // registry is empty again
    const finalStatus = makeDeps(runner);
    expect(await runCli(['machines', '--server-state', state], finalStatus.deps)).toBe(0);
    expect(finalStatus.out.join('\n')).toContain('등록된 원격 머신이 없습니다');
  });

  it('surfaces enroll failures as coded errors with exit 1', async () => {
    const state = tmp();
    const runner = new ScriptedSshRunner([
      {
        match: /TERMINULL-PROBE/,
        result: { code: 255, stdout: '', stderr: 'user@mars: Permission denied (publickey).' },
      },
    ]);
    const { deps, err } = makeDeps(runner);
    expect(await runCli(['enroll', 'mars', '--server-state', state], deps)).toBe(1);
    expect(err.join('\n')).toContain('[ssh_auth_required]');
    expect(fs.existsSync(path.join(state, MACHINES_FILE))).toBe(false);
  });
});

describe('runCli migrate dispatch', () => {
  it('migrate --from control-tower → dry-run plan, exit 0, nothing changed', async () => {
    const home = tmp();
    const claude = path.join(home, '.claude');
    fs.mkdirSync(path.join(claude, 'control-tower', 'hooks'), { recursive: true });
    const settingsPath = path.join(claude, 'settings.json');
    const bytes =
      JSON.stringify(
        {
          hooks: {
            Stop: [
              {
                matcher: '*',
                hooks: [
                  {
                    type: 'command',
                    command: path.join(claude, 'control-tower', 'hooks', 'ct-stop.sh'),
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      ) + '\n';
    fs.writeFileSync(settingsPath, bytes);

    const { deps, out } = makeDeps();
    deps.home = home;
    deps.launchAgentsDir = path.join(home, 'Library', 'LaunchAgents');
    const code = await runCli(['migrate', '--from', 'control-tower'], deps);
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('migrate --from control-tower');
    expect(out.join('\n')).toContain('control-tower 훅 1개 제거');
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(bytes); // dry run: untouched
  });

  it('migrate with an unknown --from → usage error, exit 2', async () => {
    const { deps, err } = makeDeps();
    deps.home = tmp();
    const code = await runCli(['migrate', '--from', 'nope'], deps);
    expect(code).toBe(2);
    expect(err.join('\n')).toContain('알 수 없는 마이그레이션 소스');
  });
});
