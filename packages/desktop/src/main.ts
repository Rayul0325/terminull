/**
 * Terminull desktop shell — Electron main process (M10 Track D).
 *
 * THIN CLIENT invariants (contract §0 / D6):
 *  - ZERO native modules. node-pty and all agent I/O live in the panel server;
 *    the shell only points a sandboxed window at it.
 *  - NO remote content. The window loads the panel UI from the LOOPBACK origin
 *    `http://127.0.0.1:<port>/` (the panel server is the web-bundle host). This
 *    is required, not incidental: the web client is hardwired same-origin — it
 *    builds WebSocket URLs from `location.host`
 *    (packages/web/src/terminal/connectPty.ts, api/stream.ts) and opens dockview
 *    popouts at the relative `/popout.html`, so a `file://` load would break WS
 *    and popouts. "No remote content" is enforced by construction: every
 *    navigation, window-open and network request that targets a non-loopback
 *    host is denied (see installSessionGuards / the window handlers).
 *  - Single instance: `app.requestSingleInstanceLock()`; a second launch focuses
 *    the first window.
 *  - No preload IPC: the UI talks to the loopback server over HTTP/WS, never to
 *    electron main, so there is no preload bridge (the empty IPC surface = the
 *    minimal attack surface). contextIsolation on, nodeIntegration off, sandbox
 *    on regardless.
 *
 * ATTACH mode: a live server is discovered → load it. MANAGED mode: none → spawn
 * `terminull serve`, poll server.json until live, load it, kill the child on
 * quit. When neither yields a server, an honest Korean error screen is shown.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { app, BrowserWindow, session } from 'electron';
import { defaultStateDir } from './discovery.js';
import {
  decideMode,
  pollForServer,
  resolvePanelUrl,
  resolveServeCommand,
  ServerStartTimeout,
} from './mode.js';
import { isAllowedPopout, isBlockedResource, isNavigationAllowed } from './popout.js';
import { dataUrl, SCREENS } from './screens.js';

/** The loopback host (`127.0.0.1:<port>`) the window was loaded from, or null. */
let appHost: string | null = null;
/** The managed `terminull serve` child, if the shell started one. */
let serverChild: ChildProcess | null = null;

// Test isolation seam: point single-instance lock + app data at a fake dir so
// the smoke test can run two instances without touching the real profile.
const userDataOverride = process.env['TERMINULL_USER_DATA'];
if (userDataOverride !== undefined && userDataOverride !== '') {
  app.setPath('userData', userDataOverride);
}

const gotLock = app.requestSingleInstanceLock();

/**
 * Install the session-wide "loopback only" guards. `onBeforeRequest` cancels any
 * request to a non-loopback host (the hard "no remote content" enforcement);
 * `onBeforeSendHeaders` strips the `Origin` header for loopback requests so the
 * server's originOk() always trusts the shell (same trick as the vite dev proxy,
 * packages/web/vite.config.ts); `onHeadersReceived` adds a conservative CSP when
 * the served response carries none.
 */
function installSessionGuards(sess: Electron.Session): void {
  sess.webRequest.onBeforeRequest((details, cb) => {
    cb({ cancel: isBlockedResource(details.url) });
  });
  sess.webRequest.onBeforeSendHeaders((details, cb) => {
    const headers = { ...details.requestHeaders };
    // Strip Origin only for loopback destinations (leaves nothing else, since
    // non-loopback is already cancelled above).
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'origin') delete headers[key];
    }
    cb({ requestHeaders: headers });
  });
  sess.webRequest.onHeadersReceived((details, cb) => {
    const headers = { ...details.responseHeaders };
    const hasCsp = Object.keys(headers).some((k) => k.toLowerCase() === 'content-security-policy');
    if (!hasCsp) {
      headers['Content-Security-Policy'] = [
        "default-src 'self'; " +
          "connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* ws://localhost:*; " +
          "img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; " +
          "font-src 'self' data:; script-src 'self'; worker-src 'self' blob:; " +
          "frame-src 'self'; object-src 'none'; base-uri 'self'",
      ];
    }
    cb({ responseHeaders: headers });
  });
}

/** Create the single sandboxed window with the loopback-only handlers wired. */
function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    backgroundColor: '#0e0f13',
    webPreferences: {
      // Thin client: never any node/electron in the renderer, no preload bridge.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });

  // Popout policy: allow ONLY same-loopback-host popouts (dockview /popout.html);
  // deny everything else. Popout windows inherit the sandboxed preferences.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedPopout(url, appHost)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
        },
      };
    }
    return { action: 'deny' };
  });

  // Navigation guard: refuse any navigation off the loopback origin.
  win.webContents.on('will-navigate', (event, url) => {
    if (!isNavigationAllowed(url, appHost)) event.preventDefault();
  });

  return win;
}

/** Spawn `terminull serve` and resolve once server.json names a live pid. */
async function startManagedServer(stateDir: string): Promise<number> {
  const { cmd, args } = resolveServeCommand();
  serverChild = spawn(cmd, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  serverChild.on('exit', () => {
    serverChild = null;
  });
  const disc = await pollForServer(stateDir, { timeoutMs: 15000, intervalMs: 300 });
  return disc.port;
}

/** Terminate the managed server child (idempotent). */
function killManagedServer(): void {
  const child = serverChild;
  if (!child || child.killed) return;
  serverChild = null;
  try {
    child.kill('SIGTERM');
  } catch {
    /* already gone */
  }
}

/** Resolve a port to load, spawning a managed server if none is live. */
async function resolvePort(
  stateDir: string,
): Promise<{ ok: true; port: number } | { ok: false; screen: string }> {
  const mode = decideMode(stateDir);
  if (mode.kind === 'attach') return { ok: true, port: mode.port };
  try {
    const port = await startManagedServer(stateDir);
    return { ok: true, port };
  } catch (err) {
    killManagedServer();
    const detail =
      err instanceof ServerStartTimeout
        ? `상태 폴더: ${stateDir}\n\`terminull serve\`를 실행했지만 제한 시간 안에 서버가 준비되지 않았습니다.\n터미널에서 \`terminull serve\`를 직접 실행해 로그를 확인하세요.`
        : `상태 폴더: ${stateDir}\n\`terminull serve\` 실행에 실패했습니다: ${String(err)}\nterminull이 PATH에 설치되어 있는지 확인하세요.`;
    return { ok: false, screen: SCREENS.managedFailed(detail) };
  }
}

/** Normal (windowed) boot. */
async function boot(): Promise<void> {
  const stateDir = defaultStateDir();
  installSessionGuards(session.defaultSession);
  const resolved = await resolvePort(stateDir);
  const win = createWindow();
  if (!resolved.ok) {
    appHost = null;
    void win.loadURL(dataUrl(resolved.screen));
    return;
  }
  const url = resolvePanelUrl(resolved.port);
  try {
    appHost = new URL(url).host;
  } catch {
    appHost = null;
  }
  void win.loadURL(url);
}

/**
 * Headless smoke branch (gate g): asserts the main-process modules LOAD inside
 * electron and config/mode RESOLVE — WITHOUT creating a window (the window test
 * is skipped honestly on CI when there is no display). Prints machine-readable
 * lines the smoke test parses, then quits.
 */
function runSmoke(): void {
  if (!gotLock) {
    process.stdout.write('SMOKE_RESULT ' + JSON.stringify({ lock: false }) + '\n');
    app.quit();
    return;
  }
  void app.whenReady().then(async () => {
    const stateDir = defaultStateDir();
    const mode = decideMode(stateDir);
    let extra: Record<string, unknown> = {};
    if (process.env['TERMINULL_SMOKE_MANAGED'] === '1' && mode.kind === 'managed') {
      try {
        const port = await startManagedServer(stateDir);
        extra = { managedPort: port };
      } catch (err) {
        extra = { managedError: String(err) };
      } finally {
        killManagedServer();
      }
    }
    process.stdout.write('SMOKE_READY\n');
    const finish = (): void => {
      process.stdout.write('SMOKE_RESULT ' + JSON.stringify({ lock: true, mode, ...extra }) + '\n');
      app.quit();
    };
    const hold = Number(process.env['TERMINULL_SMOKE_HOLD'] ?? '0');
    if (hold > 0) setTimeout(finish, hold);
    else finish();
  });
}

if (process.env['TERMINULL_SMOKE'] === '1') {
  runSmoke();
} else if (!gotLock) {
  // A second instance: hand off to the first and exit.
  app.quit();
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  void app.whenReady().then(() => {
    void boot();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void boot();
    });
  });

  app.on('before-quit', killManagedServer);
  app.on('will-quit', killManagedServer);
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
