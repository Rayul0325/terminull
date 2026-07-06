/**
 * End-to-end: run a REAL headless Codex turn through {@link CodexHeadlessRunner}.
 *
 * Env-gated — skipped by default so CI (no codex binary/auth) stays honest.
 * Run locally with:  TERMINULL_E2E_CODEX=1 pnpm --filter @terminull/adapter-codex test
 * Uses a trivial one-word prompt in a throwaway tmp cwd under a read-only sandbox
 * with approvals disabled, so the turn cannot touch anything and never blocks.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CodexHeadlessRunner } from '../src/driver';

const RUN = !!process.env['TERMINULL_E2E_CODEX'];

describe('E2E — real headless codex exec --json (env-gated)', () => {
  let cwd: string | null = null;
  afterAll(() => {
    if (cwd) fs.rmSync(cwd, { recursive: true, force: true });
  });

  it.skipIf(!RUN)(
    'streams a JSON event log and surfaces a final agent message',
    async () => {
      cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-codex-e2e-'));
      const runner = new CodexHeadlessRunner('codex');
      const result = await runner.run({
        prompt: 'Reply with exactly the single word: pong',
        cwd,
        sandbox: 'read-only',
        approval: 'never',
        skipGitRepoCheck: true, // the tmp cwd is not a trusted git repo
        timeoutMs: 85_000,
      });

      // A JSON event stream must have arrived.
      expect(result.sawJson).toBe(true);
      expect(result.events.length).toBeGreaterThan(0);
      // And a final agent message must have been surfaced.
      expect(typeof result.finalMessage).toBe('string');
      expect((result.finalMessage ?? '').length).toBeGreaterThan(0);
    },
    90_000,
  );
});
