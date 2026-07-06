/**
 * Enroll/remove unit tests — every remote effect goes through fake SshRunners
 * (scripted, or a local /bin/sh against a tmpdir "remote home"); a real ssh is
 * never spawned and no real home directory is read or written.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_PREAMBLE, MACHINES_FILE } from '@terminull/shared';
import { packDirToTarGz } from './bundle';
import { AGENT_DIR } from './enroll-manifest';
import {
  EnrollError,
  NVM_LATEST_CMD,
  PREFLIGHT_CMD,
  REMOVE_CMD,
  deriveMachineId,
  enroll,
  launcherScript,
  nodeProbeCmd,
  preflight,
  removeEnrollment,
  resolveRemoteNode,
  type EnrollDeps,
} from './enroll';
import { loadMachinesFile, saveMachinesFile } from './machines-file';
import { LocalHomeSshRunner, OK, ScriptedSshRunner, type ScriptedRule } from './test-fakes';
import type { SshRunner } from './ssh-runner';

const tmpdirs: string[] = [];
const children: ChildProcess[] = [];

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpdirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const child of children.splice(0)) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  for (const dir of tmpdirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function probeOk(
  version: string,
  realpath: string,
): { code: number; stdout: string; stderr: string } {
  return { code: 0, stdout: `${version}\n${realpath}\n`, stderr: '' };
}

const FAIL = { code: 127, stdout: '', stderr: 'not found' };

/** Fake bundle whose dist/bin.js answers `--probe` with the agent preamble. */
async function fakeBundle(probeSucceeds = true): Promise<Buffer> {
  const dir = tmp('tn8cli-bundle-');
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  const body = probeSucceeds
    ? `if (process.argv.includes('--probe')) { process.stdout.write('${AGENT_PREAMBLE}\\n'); process.exit(0); }\nprocess.exit(1);\n`
    : `process.stderr.write('fake agent: broken install\\n'); process.exit(1);\n`;
  fs.writeFileSync(path.join(dir, 'dist', 'bin.js'), body);
  return packDirToTarGz(dir);
}

function deps(runner: SshRunner, bundle?: () => Promise<Buffer>): EnrollDeps {
  return { runner, buildBundle: bundle ?? (() => fakeBundle()) };
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

describe('preflight', () => {
  it('parses uname and $HOME, skipping MOTD noise', async () => {
    const runner = new ScriptedSshRunner([
      {
        match: PREFLIGHT_CMD,
        result: {
          code: 0,
          stdout: 'Welcome to Ubuntu!\nTERMINULL-PROBE\nLinux x86_64\n/home/u\n',
          stderr: '',
        },
      },
    ]);
    const res = await preflight(runner, 'mars');
    expect(res).toEqual({ uname: 'Linux x86_64', home: '/home/u' });
  });

  it('classifies a BatchMode auth failure as ssh_auth_required', async () => {
    const runner = new ScriptedSshRunner([
      {
        match: PREFLIGHT_CMD,
        result: { code: 255, stdout: '', stderr: 'user@mars: Permission denied (publickey).' },
      },
    ]);
    await expect(preflight(runner, 'mars')).rejects.toMatchObject({ code: 'ssh_auth_required' });
  });

  it('classifies a dead host as ssh_unreachable', async () => {
    const runner = new ScriptedSshRunner([
      {
        match: PREFLIGHT_CMD,
        result: { code: 255, stdout: '', stderr: 'ssh: Could not resolve hostname mars' },
      },
    ]);
    await expect(preflight(runner, 'mars')).rejects.toMatchObject({ code: 'ssh_unreachable' });
  });
});

// ---------------------------------------------------------------------------
// Node resolution matrix (incl. the ~/.local/bin shadowing trap)
// ---------------------------------------------------------------------------

describe('resolveRemoteNode', () => {
  const HOME = '/home/u';

  function runnerWith(rules: ScriptedRule[]): ScriptedSshRunner {
    return new ScriptedSshRunner(rules);
  }

  it('pins the PATH node when it is new enough', async () => {
    const runner = runnerWith([
      {
        match: 'command -v node',
        result: { code: 0, stdout: '/usr/local/bin/node\n', stderr: '' },
      },
      {
        match: nodeProbeCmd('/usr/local/bin/node'),
        result: probeOk('v23.5.0', '/usr/local/bin/node'),
      },
    ]);
    const res = await resolveRemoteNode(runner, 'mars', HOME);
    expect(res).toEqual({ nodePath: '/usr/local/bin/node', version: 'v23.5.0' });
  });

  it('falls through to homebrew when PATH has no node, pinning the realpath', async () => {
    const runner = runnerWith([
      { match: 'command -v node', result: FAIL },
      {
        match: nodeProbeCmd('/opt/homebrew/bin/node'),
        result: probeOk('v22.0.0', '/opt/homebrew/Cellar/node/22.0.0/bin/node'),
      },
    ]);
    const res = await resolveRemoteNode(runner, 'mars', HOME);
    expect(res.nodePath).toBe('/opt/homebrew/Cellar/node/22.0.0/bin/node');
  });

  it('rejects an OLD ~/.local/bin shadow (fails the version gate) and uses the real node', async () => {
    const runner = runnerWith([
      {
        match: 'command -v node',
        result: { code: 0, stdout: `${HOME}/.local/bin/node\n`, stderr: '' },
      },
      {
        match: nodeProbeCmd(`${HOME}/.local/bin/node`),
        result: probeOk('v16.20.2', `${HOME}/.local/bin/node`),
      },
      {
        match: nodeProbeCmd('/opt/homebrew/bin/node'),
        result: probeOk('v24.1.0', '/opt/homebrew/Cellar/node/24.1.0/bin/node'),
      },
    ]);
    const res = await resolveRemoteNode(runner, 'mars', HOME);
    expect(res.nodePath).toBe('/opt/homebrew/Cellar/node/24.1.0/bin/node');
    expect(res.shadow).toBeUndefined();
  });

  it('SHADOW TRAP: a passing ~/.local/bin PATH node is displaced by a strictly newer real node', async () => {
    const runner = runnerWith([
      {
        match: 'command -v node',
        result: { code: 0, stdout: `${HOME}/.local/bin/node\n`, stderr: '' },
      },
      {
        match: nodeProbeCmd(`${HOME}/.local/bin/node`),
        result: probeOk('v22.1.0', `${HOME}/.local/bin/node`),
      },
      {
        match: nodeProbeCmd('/opt/homebrew/bin/node'),
        result: probeOk('v24.1.0', '/opt/homebrew/Cellar/node/24.1.0/bin/node'),
      },
      { match: nodeProbeCmd('/usr/local/bin/node'), result: FAIL },
      { match: nodeProbeCmd('/usr/bin/node'), result: FAIL },
      { match: NVM_LATEST_CMD, result: { code: 0, stdout: '', stderr: '' } },
      {
        match: nodeProbeCmd('~/.local/bin/node'),
        result: probeOk('v22.1.0', `${HOME}/.local/bin/node`),
      },
    ]);
    const res = await resolveRemoteNode(runner, 'mars', HOME);
    expect(res.nodePath).toBe('/opt/homebrew/Cellar/node/24.1.0/bin/node');
    expect(res.version).toBe('v24.1.0');
    expect(res.shadow).toEqual({ path: `${HOME}/.local/bin/node`, version: 'v22.1.0' });
  });

  it('keeps a passing ~/.local/bin node when nothing newer exists', async () => {
    const runner = runnerWith([
      {
        match: 'command -v node',
        result: { code: 0, stdout: `${HOME}/.local/bin/node\n`, stderr: '' },
      },
      {
        match: nodeProbeCmd(`${HOME}/.local/bin/node`),
        result: probeOk('v22.9.0', `${HOME}/.local/bin/node`),
      },
      { match: nodeProbeCmd('/opt/homebrew/bin/node'), result: FAIL },
      { match: nodeProbeCmd('/usr/local/bin/node'), result: FAIL },
      { match: nodeProbeCmd('/usr/bin/node'), result: FAIL },
      { match: NVM_LATEST_CMD, result: { code: 0, stdout: '', stderr: '' } },
      {
        match: nodeProbeCmd('~/.local/bin/node'),
        result: probeOk('v22.9.0', `${HOME}/.local/bin/node`),
      },
    ]);
    const res = await resolveRemoteNode(runner, 'mars', HOME);
    expect(res.nodePath).toBe(`${HOME}/.local/bin/node`);
    expect(res.shadow).toBeUndefined();
  });

  it('finds an nvm-installed node when the fixed paths are empty', async () => {
    const nvmNode = `${HOME}/.nvm/versions/node/v22.14.0/bin/node`;
    const runner = runnerWith([
      { match: 'command -v node', result: FAIL },
      { match: nodeProbeCmd('/opt/homebrew/bin/node'), result: FAIL },
      { match: nodeProbeCmd('/usr/local/bin/node'), result: FAIL },
      { match: nodeProbeCmd('/usr/bin/node'), result: FAIL },
      { match: NVM_LATEST_CMD, result: { code: 0, stdout: `${nvmNode}\n`, stderr: '' } },
      { match: nodeProbeCmd(nvmNode), result: probeOk('v22.14.0', nvmNode) },
    ]);
    const res = await resolveRemoteNode(runner, 'mars', HOME);
    expect(res.nodePath).toBe(nvmNode);
  });

  it('throws remote_node_missing (pointing at --node) when nothing qualifies', async () => {
    const runner = runnerWith([
      { match: 'command -v node', result: FAIL },
      { match: /-p "process\.version/, result: FAIL },
      { match: NVM_LATEST_CMD, result: { code: 0, stdout: '', stderr: '' } },
    ]);
    const err = await resolveRemoteNode(runner, 'mars', HOME).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EnrollError);
    expect((err as EnrollError).code).toBe('remote_node_missing');
    expect((err as EnrollError).message).toContain('--node');
  });

  it('honours an explicit --node without probing anything else', async () => {
    const runner = runnerWith([
      { match: nodeProbeCmd('/custom/node'), result: probeOk('v25.0.0', '/custom/real/node') },
    ]);
    const res = await resolveRemoteNode(runner, 'mars', HOME, '/custom/node');
    expect(res.nodePath).toBe('/custom/real/node');
    expect(runner.calls).toHaveLength(1);
  });

  it('rejects an explicit --node that is too old', async () => {
    const runner = runnerWith([
      { match: nodeProbeCmd('/custom/node'), result: probeOk('v18.19.0', '/custom/node') },
    ]);
    await expect(resolveRemoteNode(runner, 'mars', HOME, '/custom/node')).rejects.toMatchObject({
      code: 'remote_node_invalid',
    });
  });
});

// ---------------------------------------------------------------------------
// deriveMachineId
// ---------------------------------------------------------------------------

describe('deriveMachineId', () => {
  it('slugs user@Host.Domain into a valid machine id', () => {
    expect(deriveMachineId('user@Mars.Example.com')).toBe('mars-example-com');
    expect(deriveMachineId('mars')).toBe('mars');
  });
});

// ---------------------------------------------------------------------------
// Full enroll against a tmpdir "remote home" (local shell, no ssh)
// ---------------------------------------------------------------------------

describe('enroll (fake remote home)', () => {
  it('installs the exact manifest footprint, registers the machine, and is idempotent', async () => {
    const home = tmp('tn8cli-home-');
    const state = tmp('tn8cli-state-');
    const runner = new LocalHomeSshRunner(home, 'mars');

    const result = await enroll({ host: 'mars', id: 'mars', serverState: state }, deps(runner));

    const root = path.join(home, AGENT_DIR);
    // Remote footprint == manifest, VERSION present == complete install.
    expect(fs.readFileSync(path.join(root, 'VERSION'), 'utf8')).toMatch(/^0\.0\.0 /);
    const nodePath = fs.readFileSync(path.join(root, 'node-path'), 'utf8').trim();
    expect(nodePath.startsWith('/')).toBe(true);
    expect(fs.existsSync(path.join(root, 'pkg', 'dist', 'bin.js'))).toBe(true);
    const launcher = path.join(root, 'bin', 'terminull-agent');
    expect(fs.statSync(launcher).mode & 0o755).toBe(0o755);
    const script = fs.readFileSync(launcher, 'utf8');
    expect(script).toBe(launcherScript(home));
    expect(script).toContain(`${home}/${AGENT_DIR}/pkg/dist/bin.js`);
    // Nothing outside the dedicated dir was created in the fake home.
    expect(fs.readdirSync(home).sort()).toEqual([AGENT_DIR]);

    // Local registration.
    const machines = loadMachinesFile(state);
    expect(machines).toEqual([
      {
        id: 'mars',
        label: 'mars',
        transport: { kind: 'ssh', host: 'mars', sshArgs: [] },
        enabled: true,
      },
    ]);
    // machines.json is private (0600).
    const mode = fs.statSync(path.join(state, MACHINES_FILE)).mode & 0o777;
    expect(mode).toBe(0o600);
    // No server running → reload honestly not claimed.
    expect(result.reloaded).toBe(false);

    // Idempotent re-run = in-place upgrade, no duplicate entry.
    const again = await enroll(
      { host: 'mars', id: 'mars', label: 'Mars (upgraded)', serverState: state },
      deps(runner),
    );
    expect(again.machine.label).toBe('Mars (upgraded)');
    expect(loadMachinesFile(state)).toHaveLength(1);
    expect(fs.existsSync(path.join(root, 'VERSION'))).toBe(true);
  });

  it('handshake failure is honest: no VERSION stamp, no machine registered', async () => {
    const home = tmp('tn8cli-home-');
    const state = tmp('tn8cli-state-');
    const runner = new LocalHomeSshRunner(home);

    await expect(
      enroll(
        { host: 'mars', id: 'mars', serverState: state },
        deps(runner, () => fakeBundle(false)),
      ),
    ).rejects.toMatchObject({ code: 'agent_probe_failed' });

    expect(fs.existsSync(path.join(home, AGENT_DIR, 'VERSION'))).toBe(false);
    expect(fs.existsSync(path.join(state, MACHINES_FILE))).toBe(false);
  });

  it('refuses the reserved machine id before touching the remote', async () => {
    const runner = new ScriptedSshRunner([]);
    await expect(
      enroll({ host: 'mars', id: 'local', serverState: tmp('tn8cli-state-') }, deps(runner)),
    ).rejects.toMatchObject({ code: 'machine_id_invalid' });
    expect(runner.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// --remove: complete reversal
// ---------------------------------------------------------------------------

describe('removeEnrollment', () => {
  it('kills the pid-file daemon, removes the remote dir, and deregisters', async () => {
    const home = tmp('tn8cli-home-');
    const state = tmp('tn8cli-state-');
    const runner = new LocalHomeSshRunner(home, 'mars');
    await enroll({ host: 'mars', id: 'mars', serverState: state }, deps(runner));

    // Plant a live "daemon" (our own sleep child) behind host.pid.
    const daemon = spawn('sleep', ['300'], { stdio: 'ignore' });
    children.push(daemon);
    fs.writeFileSync(path.join(home, AGENT_DIR, 'host', 'host.pid'), `${daemon.pid}\n`);

    const result = await removeEnrollment({ query: 'mars', serverState: state }, deps(runner));

    expect(result.remote).toBe('removed');
    expect(result.entryRemoved).toBe(true);
    expect(result.id).toBe('mars');
    // Proof: the ONLY thing enroll created is gone; nothing else remains.
    expect(fs.existsSync(path.join(home, AGENT_DIR))).toBe(false);
    expect(loadMachinesFile(state)).toEqual([]);
    // Daemon really received the kill (it may already have exited before the
    // listener attaches — handle both orders).
    const gone = await new Promise<boolean>((resolve) => {
      if (daemon.exitCode !== null || daemon.signalCode !== null) return resolve(true);
      daemon.once('exit', () => resolve(true));
      setTimeout(() => resolve(false), 3_000);
    });
    expect(gone).toBe(true);
  });

  it('unreachable host: honest warning, local entry still dropped', async () => {
    const state = tmp('tn8cli-state-');
    saveMachinesFile(state, [
      { id: 'mars', label: 'Mars', transport: { kind: 'ssh', host: 'mars' }, enabled: true },
    ]);
    const runner = new ScriptedSshRunner([
      {
        match: REMOVE_CMD,
        result: {
          code: 255,
          stdout: '',
          stderr: 'ssh: connect to host mars port 22: Operation timed out',
        },
      },
    ]);
    const result = await removeEnrollment({ query: 'mars', serverState: state }, deps(runner));
    expect(result.remote).toBe('unreachable');
    expect(result.entryRemoved).toBe(true);
    expect(loadMachinesFile(state)).toEqual([]);
  });

  it('matches by ssh host as well as by id', async () => {
    const state = tmp('tn8cli-state-');
    saveMachinesFile(state, [
      {
        id: 'mars',
        label: 'Mars',
        transport: { kind: 'ssh', host: 'user@mars.lan' },
        enabled: true,
      },
    ]);
    const runner = new ScriptedSshRunner([
      { match: REMOVE_CMD, result: { code: 0, stdout: 'TERMINULL-REMOVED\n', stderr: '' } },
    ]);
    const result = await removeEnrollment(
      { query: 'user@mars.lan', serverState: state },
      deps(runner),
    );
    expect(result.id).toBe('mars');
    expect(result.host).toBe('user@mars.lan');
    expect(result.remote).toBe('removed');
    expect(loadMachinesFile(state)).toEqual([]);
    expect(runner.calls[0]?.host).toBe('user@mars.lan');
  });

  it('skips remote cleanup for a non-ssh (stdio test) machine but still deregisters', async () => {
    const state = tmp('tn8cli-state-');
    saveMachinesFile(state, [
      {
        id: 'fake',
        label: 'Fake',
        transport: { kind: 'stdio', cmd: 'node', args: [] },
        enabled: true,
      },
    ]);
    const runner = new ScriptedSshRunner([]); // any ssh call would throw
    const result = await removeEnrollment({ query: 'fake', serverState: state }, deps(runner));
    expect(result.remote).toBe('skipped');
    expect(result.entryRemoved).toBe(true);
    expect(runner.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// OK fixture sanity (keeps the shared fixture exported + used)
// ---------------------------------------------------------------------------

describe('test fakes', () => {
  it('scripted runner records calls and rejects unscripted commands', async () => {
    const runner = new ScriptedSshRunner([{ match: 'true', result: OK }]);
    await expect(runner.run('mars', 'true')).resolves.toEqual(OK);
    await expect(runner.run('mars', 'rm -rf /')).rejects.toThrow(/unscripted/);
    expect(runner.calls).toHaveLength(2);
  });
});
