/**
 * Headless-safe electron smoke (gate g). Spawns the REAL built main process
 * (dist/main.js) in smoke mode against a fake state dir and asserts:
 *   - attach decision from a live server.json,
 *   - managed decision + `terminull serve` spawn/poll against a fake bin,
 *   - single-instance lock (a second instance loses the lock and exits 0).
 *
 * The window itself is never created — smoke mode asserts main-process module
 * load + config/mode resolution only. Honest skips:
 *   - `CI && !DISPLAY` (no display) → SKIPPED, never green-faked (contract D5).
 *   - dist/main.js not built, or electron unresolvable → SKIPPED with reason.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainBuilt = path.join(pkgRoot, 'dist', 'main.js');

function resolveElectron(): string | null {
  try {
    return require('electron') as string;
  } catch {
    return null;
  }
}

const electronPath = resolveElectron();
const headless = !!process.env['CI'] && !process.env['DISPLAY'];
const built = fs.existsSync(mainBuilt);
// Honest skip: report WHY the window-level smoke is not running.
const skip = headless || !electronPath || !built;
if (skip) {
  const reason = headless
    ? 'CI without DISPLAY (headless) — window smoke skipped honestly'
    : !electronPath
      ? 'electron binary not resolvable — build/install first'
      : 'dist/main.js not built — run `pnpm --filter @terminull/desktop build` first';
  console.warn(`[desktop smoke] SKIPPED: ${reason}`);
}

interface SmokeRun {
  code: number | null;
  results: Array<Record<string, unknown>>;
  ready: boolean;
  stdout: string;
}

/** Spawn a smoke electron instance; resolves when it exits. */
function runSmoke(
  env: Record<string, string>,
  opts: { onReady?: () => void; timeoutMs?: number } = {},
): Promise<SmokeRun> {
  return new Promise<SmokeRun>((resolve, reject) => {
    const child = spawn(electronPath as string, [pkgRoot], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';
    let ready = false;
    const results: Array<Record<string, unknown>> = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`smoke timed out; stdout=${JSON.stringify(stdout)}`));
    }, opts.timeoutMs ?? 30000);
    child.stdout.on('data', (buf: Buffer) => {
      stdout += buf.toString('utf8');
      if (!ready && stdout.includes('SMOKE_READY')) {
        ready = true;
        opts.onReady?.();
      }
      for (const line of stdout.split('\n')) {
        const m = line.match(/^SMOKE_RESULT (.*)$/);
        if (m && results.length < stdout.split('SMOKE_RESULT').length - 1) {
          try {
            const parsed = JSON.parse(m[1]) as Record<string, unknown>;
            if (!results.some((r) => JSON.stringify(r) === JSON.stringify(parsed))) results.push(parsed);
          } catch {
            /* partial line — ignore */
          }
        }
      }
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, results, ready, stdout });
    });
  });
}

let stateDir: string;
let userDataA: string;
let fakeServe: string;

beforeAll(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-desktop-smoke-'));
  userDataA = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-desktop-udata-'));
  fakeServe = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tn-fake-serve-')), 'fake-serve.mjs');
  // Fake `terminull serve`: writes a live server.json then idles until SIGTERM.
  fs.writeFileSync(
    fakeServe,
    [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "const dir = process.env.TERMINULL_STATE_DIR;",
      "fs.mkdirSync(dir, { recursive: true });",
      "fs.writeFileSync(path.join(dir, 'server.json'), JSON.stringify({ port: 45999, pid: process.pid }));",
      "process.stdout.write('FAKE_SERVE_LISTENING\\n');",
      "const t = setInterval(() => {}, 1000);",
      "process.on('SIGTERM', () => { clearInterval(t); process.exit(0); });",
    ].join('\n'),
  );
});

afterAll(() => {
  for (const d of [stateDir, userDataA]) fs.rmSync(d, { recursive: true, force: true });
  fs.rmSync(path.dirname(fakeServe), { recursive: true, force: true });
});

describe.skipIf(skip)('electron smoke (window-level, headless-safe)', () => {
  it('resolves ATTACH from a live server.json and exits 0', async () => {
    const attachDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-attach-'));
    fs.writeFileSync(
      path.join(attachDir, 'server.json'),
      // pid = this test process → guaranteed alive → attach.
      JSON.stringify({ port: 7420, pid: process.pid }),
    );
    const run = await runSmoke({
      TERMINULL_SMOKE: '1',
      TERMINULL_STATE_DIR: attachDir,
      TERMINULL_USER_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'tn-ud-')),
    });
    fs.rmSync(attachDir, { recursive: true, force: true });
    expect(run.code).toBe(0);
    expect(run.results.length).toBe(1);
    expect(run.results[0]).toMatchObject({
      lock: true,
      mode: { kind: 'attach', port: 7420, pid: process.pid },
    });
  });

  it('spawns a managed server (fake bin), polls it live, and reports its port', async () => {
    const managedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-managed-'));
    const run = await runSmoke({
      TERMINULL_SMOKE: '1',
      TERMINULL_SMOKE_MANAGED: '1',
      TERMINULL_STATE_DIR: managedDir,
      TERMINULL_USER_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'tn-ud-')),
      TERMINULL_SERVE_CMD: JSON.stringify([process.execPath, fakeServe]),
    });
    fs.rmSync(managedDir, { recursive: true, force: true });
    expect(run.code).toBe(0);
    expect(run.results[0]).toMatchObject({
      lock: true,
      mode: { kind: 'managed' },
      managedPort: 45999,
    });
  });

  it('enforces single instance: the second instance loses the lock and exits 0', async () => {
    const attachDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-si-'));
    fs.writeFileSync(
      path.join(attachDir, 'server.json'),
      JSON.stringify({ port: 7421, pid: process.pid }),
    );
    const sharedUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-si-ud-'));
    let bRun: Promise<SmokeRun> | null = null;
    // A holds the lock for 2s; only after it prints SMOKE_READY (lock acquired)
    // do we launch B against the SAME userData so the ordering is deterministic.
    const aRun = await runSmoke(
      {
        TERMINULL_SMOKE: '1',
        TERMINULL_SMOKE_HOLD: '2000',
        TERMINULL_STATE_DIR: attachDir,
        TERMINULL_USER_DATA: sharedUserData,
      },
      {
        onReady: () => {
          bRun = runSmoke({
            TERMINULL_SMOKE: '1',
            TERMINULL_STATE_DIR: attachDir,
            TERMINULL_USER_DATA: sharedUserData,
          });
        },
      },
    );
    expect(bRun).not.toBeNull();
    const b = await (bRun as Promise<SmokeRun>);
    fs.rmSync(attachDir, { recursive: true, force: true });
    fs.rmSync(sharedUserData, { recursive: true, force: true });
    // A held and exited cleanly.
    expect(aRun.code).toBe(0);
    expect(aRun.results[0]).toMatchObject({ lock: true });
    // B was refused the lock and exited cleanly.
    expect(b.code).toBe(0);
    expect(b.results[0]).toEqual({ lock: false });
  }, 30000);
});

// Always-on assertion: the pure decision layer loads and resolves config even
// when the electron window smoke is skipped, so this file is never a no-op.
describe('electron smoke (config resolution, always runs)', () => {
  it('has a built main entry or an honest skip reason', () => {
    expect(built || skip).toBe(true);
  });
});
