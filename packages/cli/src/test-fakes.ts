/**
 * SshRunner fakes for unit tests — NEVER a real ssh.
 *
 *  - {@link ScriptedSshRunner}: fully deterministic command→result script for
 *    the node-resolution matrix and failure-path tests.
 *  - {@link LocalHomeSshRunner}: executes the command via a LOCAL `/bin/sh`
 *    against a tmpdir "remote home" (HOME + cwd swapped), so the real install
 *    command strings (mkdir/tar/cat/chmod/launcher exec) are exercised
 *    end-to-end without any network.
 *
 * Lives in src (not test/) so the fakes are importable by other packages'
 * tests later; ships no side effects.
 */
import { spawn } from 'node:child_process';
import type { SshRunner, SshRunResult } from './ssh-runner.js';

export interface ScriptedRule {
  /** Matches the exact command string (string = equality, RegExp = test). */
  match: string | RegExp;
  result: SshRunResult | ((cmd: string, stdin?: Buffer | string) => SshRunResult);
}

export const OK: SshRunResult = { code: 0, stdout: '', stderr: '' };

/** Deterministic scripted runner; unmatched commands fail the test loudly. */
export class ScriptedSshRunner implements SshRunner {
  readonly calls: Array<{ host: string; cmd: string; stdin?: Buffer | string }> = [];

  constructor(private readonly rules: ScriptedRule[]) {}

  run(host: string, cmd: string, stdin?: Buffer | string): Promise<SshRunResult> {
    this.calls.push({ host, cmd, stdin });
    for (const rule of this.rules) {
      const hit = typeof rule.match === 'string' ? rule.match === cmd : rule.match.test(cmd);
      if (hit) {
        const res = typeof rule.result === 'function' ? rule.result(cmd, stdin) : rule.result;
        return Promise.resolve(res);
      }
    }
    return Promise.reject(new Error(`ScriptedSshRunner: unscripted command: ${cmd}`));
  }
}

/**
 * Runs commands in a local `/bin/sh` with HOME (and cwd) pointed at a tmpdir
 * "remote home" — `~` expansion lands inside the fake home, so the real
 * enroll/remove command strings run for real, sandboxed.
 */
export class LocalHomeSshRunner implements SshRunner {
  readonly calls: Array<{ host: string; cmd: string }> = [];

  constructor(
    readonly home: string,
    readonly expectHost?: string,
  ) {}

  run(host: string, cmd: string, stdin?: Buffer | string): Promise<SshRunResult> {
    if (this.expectHost && host !== this.expectHost) {
      return Promise.reject(new Error(`unexpected host ${host} (want ${this.expectHost})`));
    }
    this.calls.push({ host, cmd });
    return new Promise((resolve, reject) => {
      const child = spawn('/bin/sh', ['-c', cmd], {
        cwd: this.home,
        env: { ...process.env, HOME: this.home },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
      child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
      if (stdin !== undefined) child.stdin.end(stdin);
      else child.stdin.end();
    });
  }
}
