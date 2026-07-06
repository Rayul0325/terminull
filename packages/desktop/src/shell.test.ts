/**
 * Pure-unit tests for the thin-shell decision + policy layer. These run
 * everywhere (no electron, no display) and cover the load-bearing security
 * invariants: attach/managed decision, loopback-only popout/navigation/resource
 * policy, managed-server command resolution + poll, and honest screens.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readDiscovery, type ServerDiscovery } from './discovery.js';
import {
  decideMode,
  pollForServer,
  resolvePanelUrl,
  resolveServeCommand,
  ServerStartTimeout,
} from './mode.js';
import { isAllowedPopout, isBlockedResource, isNavigationAllowed } from './popout.js';
import { dataUrl, SCREENS, screenHtml } from './screens.js';
import { isLoopbackHostname, isLoopbackUrl, panelOrigin } from './urls.js';

describe('urls: loopback predicates', () => {
  it('recognises loopback hostnames only', () => {
    expect(isLoopbackHostname('127.0.0.1')).toBe(true);
    expect(isLoopbackHostname('localhost')).toBe(true);
    expect(isLoopbackHostname('::1')).toBe(true);
    expect(isLoopbackHostname('[::1]')).toBe(true);
    expect(isLoopbackHostname('LOCALHOST')).toBe(true);
    expect(isLoopbackHostname('example.com')).toBe(false);
    expect(isLoopbackHostname('127.0.0.1.evil.com')).toBe(false);
    expect(isLoopbackHostname('10.0.0.5')).toBe(false);
  });

  it('classifies loopback URLs across http/ws schemes', () => {
    expect(isLoopbackUrl('http://127.0.0.1:7420/')).toBe(true);
    expect(isLoopbackUrl('ws://127.0.0.1:7420/pty')).toBe(true);
    expect(isLoopbackUrl('http://localhost:5173/index.html')).toBe(true);
    expect(isLoopbackUrl('https://evil.com/')).toBe(false);
    expect(isLoopbackUrl('http://169.254.1.1/')).toBe(false);
    expect(isLoopbackUrl('data:text/html,hi')).toBe(false);
    expect(isLoopbackUrl('not a url')).toBe(false);
  });

  it('builds the panel origin from a port', () => {
    expect(panelOrigin(7420)).toBe('http://127.0.0.1:7420');
  });
});

describe('popout: loopback-only allow-list', () => {
  const appHost = '127.0.0.1:7420';

  it('allows the same-host dockview popout', () => {
    expect(isAllowedPopout('http://127.0.0.1:7420/popout.html', appHost)).toBe(true);
  });

  it('denies cross-host, cross-port and remote popouts', () => {
    expect(isAllowedPopout('http://127.0.0.1:9999/popout.html', appHost)).toBe(false);
    expect(isAllowedPopout('https://evil.com/popout.html', appHost)).toBe(false);
    expect(isAllowedPopout('http://localhost:7420/popout.html', appHost)).toBe(false);
  });

  it('denies everything when no app host is known yet', () => {
    expect(isAllowedPopout('http://127.0.0.1:7420/popout.html', null)).toBe(false);
  });
});

describe('popout: navigation guard', () => {
  const appHost = '127.0.0.1:7420';
  it('permits same-origin loopback, about:blank and our data: screens', () => {
    expect(isNavigationAllowed('http://127.0.0.1:7420/session/1', appHost)).toBe(true);
    expect(isNavigationAllowed('about:blank', appHost)).toBe(true);
    expect(isNavigationAllowed('data:text/html,x', appHost)).toBe(true);
  });
  it('refuses remote and cross-host navigations', () => {
    expect(isNavigationAllowed('https://evil.com/', appHost)).toBe(false);
    expect(isNavigationAllowed('http://127.0.0.1:1/', appHost)).toBe(false);
  });
  it('accepts any loopback origin before the first load pins the host', () => {
    expect(isNavigationAllowed('http://localhost:5173/', null)).toBe(true);
    expect(isNavigationAllowed('https://evil.com/', null)).toBe(false);
  });
});

describe('popout: network resource block (no remote content)', () => {
  it('cancels non-loopback http(s)/ws(s) requests', () => {
    expect(isBlockedResource('https://cdn.example.com/app.js')).toBe(true);
    expect(isBlockedResource('http://8.8.8.8/beacon')).toBe(true);
    expect(isBlockedResource('wss://evil.com/socket')).toBe(true);
  });
  it('passes loopback traffic and local schemes', () => {
    expect(isBlockedResource('http://127.0.0.1:7420/api/health')).toBe(false);
    expect(isBlockedResource('ws://127.0.0.1:7420/ws')).toBe(false);
    expect(isBlockedResource('data:text/html,x')).toBe(false);
    expect(isBlockedResource('blob:http://127.0.0.1:7420/uuid')).toBe(false);
    expect(isBlockedResource('devtools://devtools/bundled/x.js')).toBe(false);
  });
});

describe('mode: attach vs managed decision', () => {
  it('attaches when a live server is discovered', () => {
    const mode = decideMode('/fake', { live: () => ({ port: 7420, pid: 4242 }) });
    expect(mode).toEqual({ kind: 'attach', port: 7420, pid: 4242 });
  });
  it('goes managed when no live server is discovered', () => {
    expect(decideMode('/fake', { live: () => null })).toEqual({ kind: 'managed' });
  });
});

describe('mode: serve command resolution', () => {
  it('defaults to `terminull serve`', () => {
    expect(resolveServeCommand({})).toEqual({ cmd: 'terminull', args: ['serve'] });
  });
  it('honors TERMINULL_BIN (executable swap only)', () => {
    expect(resolveServeCommand({ TERMINULL_BIN: '/opt/terminull' })).toEqual({
      cmd: '/opt/terminull',
      args: ['serve'],
    });
  });
  it('honors TERMINULL_SERVE_CMD full override (JSON array)', () => {
    expect(resolveServeCommand({ TERMINULL_SERVE_CMD: '["node","/tmp/fake.mjs","serve"]' })).toEqual(
      { cmd: 'node', args: ['/tmp/fake.mjs', 'serve'] },
    );
  });
  it('rejects a malformed TERMINULL_SERVE_CMD', () => {
    expect(() => resolveServeCommand({ TERMINULL_SERVE_CMD: 'not json' })).toThrow();
    expect(() => resolveServeCommand({ TERMINULL_SERVE_CMD: '[]' })).toThrow();
    expect(() => resolveServeCommand({ TERMINULL_SERVE_CMD: '[123]' })).toThrow();
  });
});

describe('mode: panel URL resolution (loopback-guarded override)', () => {
  it('defaults to the discovered loopback origin', () => {
    expect(resolvePanelUrl(7420, {})).toBe('http://127.0.0.1:7420');
  });
  it('honors a loopback TERMINULL_PANEL_URL (dev: vite)', () => {
    expect(resolvePanelUrl(7420, { TERMINULL_PANEL_URL: 'http://localhost:5173' })).toBe(
      'http://localhost:5173',
    );
  });
  it('refuses a remote override and falls back to loopback', () => {
    expect(resolvePanelUrl(7420, { TERMINULL_PANEL_URL: 'https://evil.com' })).toBe(
      'http://127.0.0.1:7420',
    );
  });
});

describe('mode: pollForServer', () => {
  it('resolves once server.json names a live pid', async () => {
    let reads = 0;
    const disc = await pollForServer('/fake', {
      timeoutMs: 1000,
      intervalMs: 1,
      now: () => reads * 10,
      sleep: async () => {},
      read: () => (++reads >= 3 ? { port: 7420, pid: 99 } : null),
      alive: () => true,
    });
    expect(disc).toEqual({ port: 7420, pid: 99 });
    expect(reads).toBe(3);
  });

  it('ignores a stale server.json (dead pid) and times out honestly', async () => {
    let clock = 0;
    await expect(
      pollForServer('/fake', {
        timeoutMs: 50,
        intervalMs: 10,
        now: () => (clock += 20),
        sleep: async () => {},
        read: () => ({ port: 7420, pid: 1 }),
        alive: () => false, // pid not alive → never trusted
      }),
    ).rejects.toBeInstanceOf(ServerStartTimeout);
  });
});

describe('screens: honest, escaped, self-contained', () => {
  it('escapes injected detail text', () => {
    const html = screenHtml('제목', '<script>alert(1)</script> & "x"');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
    expect(html).toContain('&quot;');
  });
  it('produces a decodable data: URL', () => {
    const url = dataUrl(SCREENS.managedFailed('상태 폴더: /x'));
    expect(url.startsWith('data:text/html;charset=utf-8,')).toBe(true);
    const decoded = decodeURIComponent(url.slice('data:text/html;charset=utf-8,'.length));
    expect(decoded).toContain('패널 서버를 시작하지 못했습니다');
    expect(decoded).toContain('상태 폴더: /x');
  });
});

describe('discovery: server.json reader (fake state dir)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-desktop-disc-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads a well-formed server.json', () => {
    const disc: ServerDiscovery = { port: 7420, pid: 4242 };
    fs.writeFileSync(path.join(dir, 'server.json'), JSON.stringify(disc));
    expect(readDiscovery(dir)).toEqual(disc);
  });
  it('returns null for absent or malformed files', () => {
    expect(readDiscovery(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, 'server.json'), '{ not json');
    expect(readDiscovery(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, 'server.json'), JSON.stringify({ port: 'x' }));
    expect(readDiscovery(dir)).toBeNull();
  });
});
