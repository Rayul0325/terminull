/**
 * Product-command tests (gate (a)): the WHOLE setup flow against a FAKE home —
 * detect → consent(--yes) → inject → service → synthetic-event healthcheck that
 * drives the REALLY-installed hook script against a fixture events listener.
 * Plus doctor, uninstall (data survives without --purge), and consent decline.
 *
 * The fixture panel is a local 127.0.0.1 HTTP listener (packages/server is NOT
 * imported); tool detection + service + prompts are all seams. No real
 * `~/.claude` / `~/.codex` / `~/.terminull` is ever touched.
 */
import { createServer, type Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { INJECTED_LEDGER_FILE, InjectionEngine } from '@terminull/core';
import {
  type SetupDeps,
  type ToolDetection,
  runDoctor,
  runInject,
  runSetup,
  runUninstall,
} from './commands';
import type { ServiceManager, ServiceStatus } from './service';

const tmpdirs: string[] = [];
const servers: Server[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-cmd-'));
  tmpdirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const d of tmpdirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(undefined)));
});

/** A minimal events endpoint: POST records, GET returns rows since a seq. */
async function startFixturePanel(): Promise<{ url: string; port: number; events: unknown[] }> {
  const events: { seq: number; [k: string]: unknown }[] = [];
  let seq = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'POST' && url.pathname === '/api/events') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body) as Record<string, unknown>;
          seq += 1;
          events.push({ seq, ...parsed });
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ seq }));
        } catch {
          res.writeHead(400);
          res.end();
        }
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      const since = Number(url.searchParams.get('since') ?? '0');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ events: events.filter((e) => e.seq > since), seq }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { url: `http://127.0.0.1:${port}`, port, events };
}

function fakeService(): ServiceManager & { installed: boolean } {
  const state = { installed: false };
  return {
    platform: 'darwin',
    installed: false,
    install() {
      state.installed = true;
      this.installed = true;
      return Promise.resolve({ ok: true as const, code: 'ok' as const });
    },
    uninstall() {
      this.installed = false;
      return Promise.resolve({ ok: true as const, code: 'ok' as const });
    },
    status(): Promise<ServiceStatus> {
      return Promise.resolve({ supported: true, installed: this.installed, loaded: this.installed });
    },
    start() {
      return Promise.resolve({ ok: true as const, code: 'ok' as const });
    },
    stop() {
      return Promise.resolve({ ok: true as const, code: 'ok' as const });
    },
  };
}

function detectAll(present: string[]): (bin: string) => Promise<ToolDetection> {
  return (bin) =>
    Promise.resolve(present.includes(bin) ? { present: true, version: '1.0.0' } : { present: false });
}

function makeDeps(over: Partial<SetupDeps> = {}): { deps: SetupDeps; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const home = tmp();
  const stateDir = tmp();
  const deps: SetupDeps = {
    home,
    stateDir,
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    detectTool: detectAll(['claude', 'codex']),
    prompt: () => Promise.resolve(false),
    serviceManager: fakeService(),
    nodePath: process.execPath,
    entry: '/fake/bin.js',
    coreVersion: '0.1.0',
    ...over,
  };
  return { deps, out, err };
}

function writeServerJson(stateDir: string, port: number): void {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'server.json'),
    JSON.stringify({ port, pid: process.pid, protocol: 1, coreVersion: '0.1.0' }),
  );
}

describe('runSetup — full flow (gate a)', () => {
  it('detect → consent(--yes) → inject → service → synthetic event round-trips on the panel', async () => {
    const panel = await startFixturePanel();
    const { deps, out, err } = makeDeps();
    writeServerJson(deps.stateDir, panel.port);

    const code = await runSetup({ yes: true }, deps);
    expect(code).toBe(0);
    expect(err).toEqual([]);

    // both tools injected + recorded
    const engine = new InjectionEngine({
      ledgerPath: path.join(deps.stateDir, INJECTED_LEDGER_FILE),
    });
    expect(await engine.status('claude')).not.toBeNull();
    expect(await engine.status('codex')).not.toBeNull();

    // service installed + panel url printed
    expect((deps.serviceManager as ReturnType<typeof fakeService>).installed).toBe(true);
    expect(out.join('\n')).toContain(panel.url);

    // the synthetic-event healthcheck actually reached the fixture panel
    const kinds = panel.events.map((e) => (e as { type?: string }).type);
    expect(kinds).toContain('session.start'); // claude hook fired
    expect(kinds).toContain('codex.turn'); // codex notify wrapper fired
    expect(out.join('\n')).toMatch(/synthetic .* event round-trip OK|합성 이벤트 왕복 확인/);
  });

  it('honestly skips a tool whose CLI is absent', async () => {
    const { deps, out } = makeDeps({ detectTool: detectAll(['claude']) });
    await runSetup({ yes: true }, deps);
    expect(out.join('\n')).toMatch(/codex: CLI not found|codex: PATH에서 CLI를 찾지 못해/);
  });
});

describe('consent gating', () => {
  it('declining the prompt injects nothing (no --yes, prompt=false)', async () => {
    const { deps } = makeDeps({ prompt: () => Promise.resolve(false) });
    await runInject({ tool: 'claude' }, deps);
    const engine = new InjectionEngine({
      ledgerPath: path.join(deps.stateDir, INJECTED_LEDGER_FILE),
    });
    expect(await engine.status('claude')).toBeNull();
    expect(fs.existsSync(path.join(deps.home, '.claude', 'settings.json'))).toBe(false);
  });

  it('accepting the prompt injects (prompt=true, no --yes)', async () => {
    const { deps } = makeDeps({ prompt: () => Promise.resolve(true) });
    await runInject({ tool: 'claude' }, deps);
    const engine = new InjectionEngine({
      ledgerPath: path.join(deps.stateDir, INJECTED_LEDGER_FILE),
    });
    expect(await engine.status('claude')).not.toBeNull();
  });
});

describe('runDoctor', () => {
  it('reports healthy with a live panel + intact injection', async () => {
    const panel = await startFixturePanel();
    const { deps, out } = makeDeps();
    writeServerJson(deps.stateDir, panel.port);
    await runInject({ yes: true }, deps);

    const code = await runDoctor(deps);
    expect(code).toBe(0);
    const joined = out.join('\n');
    expect(joined).toMatch(/events API reachable|이벤트 API 연결됨/);
    expect(joined).toMatch(/injected artifacts intact|주입 산출물 무결성 확인/);
  });

  it('flags integrity drift when an injected script is deleted', async () => {
    const { deps, err } = makeDeps();
    await runInject({ tool: 'claude', yes: true }, deps);
    // delete one injected script → integrity check must catch it
    const hooks = path.join(deps.home, '.claude', 'terminull', 'hooks');
    fs.rmSync(path.join(hooks, 'terminull-session-start.sh'));
    const code = await runDoctor(deps);
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/injected file missing|주입 파일 누락/);
  });
});

describe('runUninstall — data safety (gate: stateDir survives without --purge)', () => {
  it('ejects all tools + removes service but KEEPS the data dir without --purge', async () => {
    const { deps, out } = makeDeps();
    await runInject({ yes: true }, deps);
    const svc = deps.serviceManager as ReturnType<typeof fakeService>;
    svc.installed = true;

    const code = await runUninstall({ yes: true }, deps); // --yes alone must NOT purge
    expect(code).toBe(0);
    expect(svc.installed).toBe(false);
    expect(fs.existsSync(deps.stateDir)).toBe(true); // data kept
    expect(out.join('\n')).toMatch(/data dir kept|데이터 디렉터리를/);
  });

  it('--purge + confirm deletes the data dir', async () => {
    const { deps } = makeDeps({ prompt: () => Promise.resolve(true) });
    await runInject({ yes: true }, deps);
    await runUninstall({ purge: true }, deps);
    expect(fs.existsSync(deps.stateDir)).toBe(false);
  });

  it('--purge but the confirm is declined keeps the data dir', async () => {
    const { deps } = makeDeps({ prompt: () => Promise.resolve(false) });
    await runInject({ yes: true }, deps);
    await runUninstall({ purge: true }, deps);
    expect(fs.existsSync(deps.stateDir)).toBe(true);
  });
});
