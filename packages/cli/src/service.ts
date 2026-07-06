/**
 * Background-service management for the panel (contract §D3a).
 *
 * Only macOS is supported in v0.x: a LaunchAgent plist generated with the
 * ABSOLUTE node path (`process.execPath`) — never a bare `node`, which a
 * GUI-launched agent would not find. linux/windows return an explicit
 * `unsupported` result (honest error, never silent success).
 *
 * Testability: plist RENDERING is a pure function ({@link renderLaunchAgentPlist})
 * pinned by a string golden; every `launchctl` call goes through the injected
 * {@link LaunchctlRunner} seam and the plist is written under an injectable
 * LaunchAgents dir — so tests run against fake homes and NEVER touch the real
 * `~/Library/LaunchAgents` or execute `launchctl`.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';

/** Reverse-DNS launchd label for the panel agent. */
export const SERVICE_LABEL = 'com.terminull.panel';

/** Result of a mutating service op. */
export interface ServiceResult {
  ok: boolean;
  /** Machine code: `ok` | `unsupported` | `launchctl_failed` | `io_failed`. */
  code: 'ok' | 'unsupported' | 'launchctl_failed' | 'io_failed';
  detail?: string;
}

/** Service liveness. */
export interface ServiceStatus {
  supported: boolean;
  /** Plist installed on disk. */
  installed: boolean;
  /** launchd reports the label loaded. */
  loaded: boolean;
  detail?: string;
}

/** What the panel service needs to run. */
export interface ServiceSpec {
  /** Absolute node binary (`process.execPath`). */
  nodePath: string;
  /** Absolute entry script (the installed `bin.js`). */
  entry: string;
  /** Args after the entry (e.g. `['serve']`). */
  serveArgs: string[];
  /** State dir passed as `TERMINULL_STATE_DIR`. */
  stateDir: string;
  /** Dir for stdout/stderr logs. */
  logDir: string;
}

/** The service surface every platform impl provides. */
export interface ServiceManager {
  readonly platform: string;
  install(spec: ServiceSpec): Promise<ServiceResult>;
  uninstall(): Promise<ServiceResult>;
  status(): Promise<ServiceStatus>;
  start(): Promise<ServiceResult>;
  stop(): Promise<ServiceResult>;
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Render the LaunchAgent plist for the panel. PURE (no fs, no clock) so a
 * golden test pins the exact bytes, including the absolute node path.
 */
export function renderLaunchAgentPlist(spec: ServiceSpec): string {
  const programArgs = [spec.nodePath, spec.entry, ...spec.serveArgs];
  const argXml = programArgs.map((a) => `    <string>${xmlEscape(a)}</string>`).join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${SERVICE_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    argXml,
    '  </array>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    '    <key>TERMINULL_STATE_DIR</key>',
    `    <string>${xmlEscape(spec.stateDir)}</string>`,
    '  </dict>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <false/>',
    '  <key>ProcessType</key>',
    '  <string>Background</string>',
    '  <key>StandardOutPath</key>',
    `  <string>${xmlEscape(path.join(spec.logDir, 'panel.out.log'))}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${xmlEscape(path.join(spec.logDir, 'panel.err.log'))}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/** Result of one `launchctl` invocation. */
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}
/** Seam for `launchctl` — never executed in tests. */
export type LaunchctlRunner = (args: string[]) => Promise<RunResult>;

/** darwin LaunchAgent implementation. */
export class DarwinServiceManager implements ServiceManager {
  readonly platform = 'darwin';
  private readonly plistPath: string;

  constructor(
    private readonly launchAgentsDir: string,
    private readonly run: LaunchctlRunner,
  ) {
    this.plistPath = path.join(launchAgentsDir, `${SERVICE_LABEL}.plist`);
  }

  async install(spec: ServiceSpec): Promise<ServiceResult> {
    try {
      await fsp.mkdir(this.launchAgentsDir, { recursive: true });
      await fsp.mkdir(spec.logDir, { recursive: true });
      const tmp = `${this.plistPath}.tmp-${process.pid}`;
      await fsp.writeFile(tmp, renderLaunchAgentPlist(spec), { mode: 0o644 });
      await fsp.rename(tmp, this.plistPath);
    } catch (err) {
      return { ok: false, code: 'io_failed', detail: (err as Error).message };
    }
    // Reload: unload any prior definition (ignore failure), then load -w.
    await this.run(['unload', this.plistPath]).catch(() => undefined);
    const loaded = await this.run(['load', '-w', this.plistPath]);
    if (loaded.code !== 0) {
      return { ok: false, code: 'launchctl_failed', detail: loaded.stderr.trim() };
    }
    return { ok: true, code: 'ok' };
  }

  async uninstall(): Promise<ServiceResult> {
    await this.run(['unload', this.plistPath]).catch(() => undefined);
    try {
      await fsp.unlink(this.plistPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        return { ok: false, code: 'io_failed', detail: (err as Error).message };
      }
    }
    return { ok: true, code: 'ok' };
  }

  async status(): Promise<ServiceStatus> {
    let installed = false;
    try {
      await fsp.access(this.plistPath);
      installed = true;
    } catch {
      installed = false;
    }
    const listed = await this.run(['list', SERVICE_LABEL]).catch(() => ({
      code: 1,
      stdout: '',
      stderr: '',
    }));
    return { supported: true, installed, loaded: listed.code === 0 };
  }

  async start(): Promise<ServiceResult> {
    const r = await this.run(['start', SERVICE_LABEL]);
    return r.code === 0
      ? { ok: true, code: 'ok' }
      : { ok: false, code: 'launchctl_failed', detail: r.stderr.trim() };
  }

  async stop(): Promise<ServiceResult> {
    const r = await this.run(['stop', SERVICE_LABEL]);
    return r.code === 0
      ? { ok: true, code: 'ok' }
      : { ok: false, code: 'launchctl_failed', detail: r.stderr.trim() };
  }
}

/** linux/windows: honest `unsupported`, never a silent success. */
export class UnsupportedServiceManager implements ServiceManager {
  constructor(readonly platform: string) {}
  private unsupported(): ServiceResult {
    return {
      ok: false,
      code: 'unsupported',
      detail: `background service is not supported on ${this.platform} yet (macOS only in v0.x)`,
    };
  }
  install(): Promise<ServiceResult> {
    return Promise.resolve(this.unsupported());
  }
  uninstall(): Promise<ServiceResult> {
    return Promise.resolve(this.unsupported());
  }
  status(): Promise<ServiceStatus> {
    return Promise.resolve({ supported: false, installed: false, loaded: false });
  }
  start(): Promise<ServiceResult> {
    return Promise.resolve(this.unsupported());
  }
  stop(): Promise<ServiceResult> {
    return Promise.resolve(this.unsupported());
  }
}

/** Real `launchctl` runner (production only). */
export const realLaunchctl: LaunchctlRunner = async (args) => {
  const { execFile } = await import('node:child_process');
  return new Promise<RunResult>((resolve) => {
    execFile('launchctl', args, { timeout: 10_000 }, (err, stdout, stderr) => {
      const code =
        err && typeof (err as { code?: number }).code === 'number'
          ? (err as { code: number }).code
          : err
            ? 1
            : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
};

/** Build the platform-appropriate manager (darwin real; others unsupported). */
export function createServiceManager(opts: {
  platform?: string;
  launchAgentsDir: string;
  runner?: LaunchctlRunner;
}): ServiceManager {
  const platform = opts.platform ?? process.platform;
  if (platform === 'darwin') {
    return new DarwinServiceManager(opts.launchAgentsDir, opts.runner ?? realLaunchctl);
  }
  return new UnsupportedServiceManager(platform);
}
