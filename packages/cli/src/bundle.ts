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

/**
 * Build the real session-host agent bundle via `pnpm deploy` (prod deps only)
 * and pack it. Requires running inside the Terminull workspace; failures are
 * surfaced to the caller as a coded enroll error.
 */
export async function buildSessionHostBundle(): Promise<Buffer> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-bundle-'));
  const deployDir = path.join(scratch, 'pkg');
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        'pnpm',
        ['--filter', '@terminull/session-host', 'deploy', '--prod', deployDir],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      let stderr = '';
      child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`pnpm deploy exited ${code}: ${stderr.slice(-400)}`));
      });
    });
    return await packDirToTarGz(deployDir);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
