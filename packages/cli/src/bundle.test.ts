/**
 * Failure-detail tests for the bundle child runner (M9 C1). The M8 live
 * enroll run lost the real pnpm error because pnpm wrote it to STDOUT and
 * only a stderr tail was kept — these tests script a child (plain `node -e`,
 * never real pnpm) and assert the MERGED stdout+stderr tail survives.
 */
import { describe, expect, it } from 'vitest';
import { CHILD_OUTPUT_TAIL_CHARS, runChildMergedTail } from './bundle';

/** Run `node -e <script>` through the production child runner. */
function runScripted(script: string): Promise<void> {
  return runChildMergedTail('pnpm deploy', process.execPath, ['-e', script]);
}

describe('runChildMergedTail', () => {
  it('resolves on exit 0 (no error even with noisy output)', async () => {
    await expect(
      runScripted(`process.stdout.write('ok noise'); process.exit(0);`),
    ).resolves.toBeUndefined();
  });

  it('keeps a STDOUT-only error in the failure message (M8 regression)', async () => {
    await expect(
      runScripted(
        `process.stdout.write('ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE on stdout'); process.exit(1);`,
      ),
    ).rejects.toThrow(/pnpm deploy exited 1: .*ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE on stdout/);
  });

  it('merges stdout and stderr into one tail', async () => {
    // Chunk arrival order across stdout/stderr is platform/timing dependent
    // (observed 'stderr-part' before 'stdout-part' on Linux, reversed on
    // macOS) — assert both pieces landed in the tail without pinning order.
    let message = '';
    await runScripted(
      `process.stderr.write('stderr-part '); process.stdout.write('stdout-part'); process.exit(3);`,
    ).catch((err: Error) => (message = err.message));
    expect(message).toMatch(/exited 3: /);
    expect(message).toContain('stderr-part');
    expect(message).toContain('stdout-part');
  });

  it(`truncates the merged tail to the last ${CHILD_OUTPUT_TAIL_CHARS} chars`, async () => {
    const script =
      `process.stdout.write('x'.repeat(${CHILD_OUTPUT_TAIL_CHARS + 300}));` +
      `process.stderr.write('TAIL_MARKER'); process.exit(1);`;
    let message = '';
    await runScripted(script).catch((err: Error) => (message = err.message));
    expect(message).toContain('TAIL_MARKER');
    const tail = message.slice(message.indexOf('exited 1: ') + 'exited 1: '.length);
    expect(tail).toHaveLength(CHILD_OUTPUT_TAIL_CHARS);
  });

  it('reports the signal when the child dies without an exit code', async () => {
    await expect(runScripted(`process.kill(process.pid, 'SIGKILL');`)).rejects.toThrow(
      /pnpm deploy exited signal SIGKILL/,
    );
  });

  it('rejects with a spawn error for a missing executable', async () => {
    await expect(
      runChildMergedTail('pnpm deploy', '/nonexistent/tn9-no-such-bin', []),
    ).rejects.toThrow(/ENOENT/);
  });
});
