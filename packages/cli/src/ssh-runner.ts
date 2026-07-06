/**
 * SshRunner — the ONLY seam through which the CLI executes anything on a
 * remote host. Production uses {@link RealSshRunner} (spawns the system `ssh`
 * with `-T -o BatchMode=yes`, matching `sshSpecToStdio`); unit tests inject
 * fakes (scripted outputs or a tmpdir "remote home" executed via a local
 * shell) — a real `ssh` is NEVER spawned in tests.
 */
import { spawn } from 'node:child_process';

/** Result of one remote command. Streams are captured, bounded by the caller. */
export interface SshRunResult {
  /** Process exit code; -1 when the process could not be spawned/timed out. */
  code: number;
  stdout: string;
  stderr: string;
}

/** The seam. `command` is a POSIX shell line run by the remote user's shell. */
export interface SshRunner {
  run(host: string, command: string, stdin?: Buffer | string): Promise<SshRunResult>;
}

/** Options for {@link RealSshRunner}. */
export interface RealSshRunnerOptions {
  /** Hard per-command timeout (a hung link must fail honestly). Default 60s. */
  timeoutMs?: number;
  /** Extra ssh args (e.g. `-o ConnectTimeout=5`). */
  sshArgs?: string[];
}

/** Cap captured output so a chatty remote cannot balloon CLI memory. */
const MAX_CAPTURE = 1024 * 1024;

function capped(current: string, chunk: Buffer): string {
  if (current.length >= MAX_CAPTURE) return current;
  return (current + chunk.toString('utf8')).slice(0, MAX_CAPTURE);
}

/**
 * Spawns `ssh -T -o BatchMode=yes [sshArgs] <host> <command>`. `-T` keeps the
 * byte stream clean; BatchMode turns a would-be password prompt into an
 * immediate failure instead of a hang (contract §10).
 */
export class RealSshRunner implements SshRunner {
  private readonly timeoutMs: number;
  private readonly sshArgs: string[];

  constructor(opts: RealSshRunnerOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.sshArgs = opts.sshArgs ?? [];
  }

  run(host: string, command: string, stdin?: Buffer | string): Promise<SshRunResult> {
    return new Promise((resolve) => {
      const child = spawn('ssh', ['-T', '-o', 'BatchMode=yes', ...this.sshArgs, host, command], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (code: number, extraErr = ''): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, stdout, stderr: stderr + extraErr });
      };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(-1, `\nssh timed out after ${this.timeoutMs}ms`);
      }, this.timeoutMs);
      child.stdout.on('data', (c: Buffer) => (stdout = capped(stdout, c)));
      child.stderr.on('data', (c: Buffer) => (stderr = capped(stderr, c)));
      child.on('error', (err) => finish(-1, `\n${err.message}`));
      child.on('close', (code) => finish(code ?? -1));
      if (stdin !== undefined) child.stdin.end(stdin);
      else child.stdin.end();
    });
  }
}
