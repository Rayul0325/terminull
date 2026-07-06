/**
 * ServiceManager tests — plist RENDERING is pinned as a byte golden (absolute
 * node path is load-bearing), and every launchctl call goes through a fake
 * runner against a FAKE LaunchAgents dir. No real `launchctl`, no real
 * `~/Library/LaunchAgents`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DarwinServiceManager,
  type RunResult,
  SERVICE_LABEL,
  UnsupportedServiceManager,
  createServiceManager,
  renderLaunchAgentPlist,
} from './service';

const tmpdirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-svc-'));
  tmpdirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tmpdirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const SPEC = {
  nodePath: '/opt/homebrew/bin/node',
  entry: '/usr/local/lib/terminull/bin.js',
  serveArgs: ['serve'],
  stateDir: '/Users/rayul/.terminull',
  logDir: '/Users/rayul/.terminull/logs',
};

describe('renderLaunchAgentPlist (golden)', () => {
  it('embeds the ABSOLUTE node path as ProgramArguments[0]', () => {
    const plist = renderLaunchAgentPlist(SPEC);
    expect(plist).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        '<dict>',
        '  <key>Label</key>',
        '  <string>com.terminull.panel</string>',
        '  <key>ProgramArguments</key>',
        '  <array>',
        '    <string>/opt/homebrew/bin/node</string>',
        '    <string>/usr/local/lib/terminull/bin.js</string>',
        '    <string>serve</string>',
        '  </array>',
        '  <key>EnvironmentVariables</key>',
        '  <dict>',
        '    <key>TERMINULL_STATE_DIR</key>',
        '    <string>/Users/rayul/.terminull</string>',
        '  </dict>',
        '  <key>RunAtLoad</key>',
        '  <true/>',
        '  <key>KeepAlive</key>',
        '  <false/>',
        '  <key>ProcessType</key>',
        '  <string>Background</string>',
        '  <key>StandardOutPath</key>',
        '  <string>/Users/rayul/.terminull/logs/panel.out.log</string>',
        '  <key>StandardErrorPath</key>',
        '  <string>/Users/rayul/.terminull/logs/panel.err.log</string>',
        '</dict>',
        '</plist>',
        '',
      ].join('\n'),
    );
  });

  it('XML-escapes paths containing special characters', () => {
    const plist = renderLaunchAgentPlist({ ...SPEC, stateDir: '/Users/a&b/<state>' });
    expect(plist).toContain('<string>/Users/a&amp;b/&lt;state&gt;</string>');
    expect(plist).not.toContain('<string>/Users/a&b/<state></string>');
  });
});

describe('DarwinServiceManager (fake launchctl + fake LaunchAgents dir)', () => {
  function fakeRunner(): { run: (a: string[]) => Promise<RunResult>; calls: string[][] } {
    const calls: string[][] = [];
    return {
      calls,
      run: (args) => {
        calls.push(args);
        // `list` before install ⇒ not loaded (code 1); everything else ⇒ ok.
        if (args[0] === 'list') return Promise.resolve({ code: 1, stdout: '', stderr: '' });
        return Promise.resolve({ code: 0, stdout: '', stderr: '' });
      },
    };
  }

  it('install writes the plist under the fake dir and calls launchctl load -w', async () => {
    const agents = tmp();
    const runner = fakeRunner();
    const mgr = new DarwinServiceManager(agents, runner.run);
    const res = await mgr.install({ ...SPEC, stateDir: tmp(), logDir: tmp() });
    expect(res.ok).toBe(true);
    const plistPath = path.join(agents, `${SERVICE_LABEL}.plist`);
    expect(fs.existsSync(plistPath)).toBe(true);
    expect(runner.calls).toContainEqual(['unload', plistPath]);
    expect(runner.calls).toContainEqual(['load', '-w', plistPath]);
  });

  it('uninstall unloads and removes the plist (idempotent when absent)', async () => {
    const agents = tmp();
    const runner = fakeRunner();
    const mgr = new DarwinServiceManager(agents, runner.run);
    await mgr.install({ ...SPEC, stateDir: tmp(), logDir: tmp() });
    const res = await mgr.uninstall();
    expect(res.ok).toBe(true);
    expect(fs.existsSync(path.join(agents, `${SERVICE_LABEL}.plist`))).toBe(false);
    // second uninstall is still ok (ENOENT swallowed)
    expect((await mgr.uninstall()).ok).toBe(true);
  });

  it('status reports installed + loaded from disk and launchctl exit', async () => {
    const agents = tmp();
    const runnerLoaded = {
      run: (args: string[]): Promise<RunResult> =>
        Promise.resolve(
          args[0] === 'list'
            ? { code: 0, stdout: 'ok', stderr: '' }
            : { code: 0, stdout: '', stderr: '' },
        ),
    };
    const mgr = new DarwinServiceManager(agents, runnerLoaded.run);
    // before install: not installed, not loaded
    let st = await mgr.status();
    expect(st.installed).toBe(false);
    await mgr.install({ ...SPEC, stateDir: tmp(), logDir: tmp() });
    st = await mgr.status();
    expect(st).toMatchObject({ supported: true, installed: true, loaded: true });
  });

  it('launchctl load failure surfaces launchctl_failed', async () => {
    const agents = tmp();
    const failing = (args: string[]): Promise<RunResult> =>
      Promise.resolve(
        args[0] === 'load'
          ? { code: 1, stdout: '', stderr: 'Load failed: 5: Input/output error' }
          : { code: 0, stdout: '', stderr: '' },
      );
    const mgr = new DarwinServiceManager(agents, failing);
    const res = await mgr.install({ ...SPEC, stateDir: tmp(), logDir: tmp() });
    expect(res).toMatchObject({ ok: false, code: 'launchctl_failed' });
  });
});

describe('UnsupportedServiceManager', () => {
  it('returns honest unsupported for every mutating op', async () => {
    const mgr = new UnsupportedServiceManager('linux');
    expect((await mgr.install(SPEC)).code).toBe('unsupported');
    expect((await mgr.uninstall()).code).toBe('unsupported');
    expect((await mgr.status()).supported).toBe(false);
    expect((await mgr.start()).code).toBe('unsupported');
  });

  it('createServiceManager picks darwin vs unsupported by platform', () => {
    expect(createServiceManager({ platform: 'darwin', launchAgentsDir: tmp() }).platform).toBe(
      'darwin',
    );
    expect(createServiceManager({ platform: 'linux', launchAgentsDir: tmp() }).platform).toBe(
      'linux',
    );
  });
});
