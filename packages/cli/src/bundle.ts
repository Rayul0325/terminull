/**
 * Agent bundle packing — turns a prepared directory (session-host dist + prod
 * deps) into the tar.gz stream that `terminull enroll` pipes over ssh stdin.
 *
 * Production path: `pnpm --filter @terminull/session-host deploy --prod <tmp>`
 * into a scratch dir, then {@link packDirToTarGz}. Unit tests never run pnpm —
 * they pack a tiny fake bundle dir and inject it through the EnrollDeps seam
 * (full packaging polish is M10's scope).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Tar-gzip a directory's CONTENTS (paths relative to `dir`). */
export function packDirToTarGz(dir: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-czf', '-', '-C', dir, '.'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`tar exited ${code}: ${stderr.slice(-400)}`));
    });
  });
}

/** How many trailing characters of the merged child output a failure keeps. */
export const CHILD_OUTPUT_TAIL_CHARS = 400;

/**
 * Spawn a child with BOTH stdout and stderr captured, merged in arrival
 * order. On non-zero exit the rejection carries the last
 * {@link CHILD_OUTPUT_TAIL_CHARS} chars of that MERGED tail — pnpm writes its
 * real errors to STDOUT, so the stderr-only tail kept before M9 lost the
 * actual failure reason (M8 live enroll run).
 */
export function runChildMergedTail(
  label: string,
  cmd: string,
  args: readonly string[],
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let merged = '';
    const capture = (c: Buffer): void => {
      merged += c.toString('utf8');
      // Bound memory: only the tail can ever reach the error message.
      if (merged.length > CHILD_OUTPUT_TAIL_CHARS * 2) {
        merged = merged.slice(-CHILD_OUTPUT_TAIL_CHARS);
      }
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) resolve();
      else {
        const exit = code === null ? `signal ${signal ?? 'unknown'}` : String(code);
        reject(new Error(`${label} exited ${exit}: ${merged.slice(-CHILD_OUTPUT_TAIL_CHARS)}`));
      }
    });
  });
}

/**
 * Build the real session-host agent bundle via `pnpm deploy` (prod deps only)
 * and pack it. Requires running inside the Terminull workspace; failures are
 * surfaced to the caller as a coded enroll error.
 */
export async function buildSessionHostBundle(): Promise<Buffer> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-bundle-'));
  const deployDir = path.join(scratch, 'pkg');
  try {
    // --legacy: pnpm v10 refuses `deploy` in non-injected workspaces
    // (ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE); legacy mode packs workspace
    // deps (@terminull/shared) into node_modules, which is exactly what the
    // remote bundle needs. Found by the M8 live enroll run.
    await runChildMergedTail('pnpm deploy', 'pnpm', [
      '--filter',
      '@terminull/session-host',
      'deploy',
      '--legacy',
      '--prod',
      deployDir,
    ]);
    return await packDirToTarGz(deployDir);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
