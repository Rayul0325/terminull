# @terminull/desktop

A **thin Electron shell** around the Terminull panel server. It renders the same
web panel you get in a browser, in a native window — nothing more. All agent
I/O, PTYs and state live in the panel server; the shell only points a sandboxed
window at it.

## Hard invariants (M10 contract §0 / D6)

- **Zero native modules.** The package has **no runtime dependencies** — only
  `electron` as a devDependency. `node-pty` and every native module stay in the
  server/session-host. Verify: `pnpm --filter @terminull/desktop why node-pty`
  prints nothing.
- **Thin client, no preload IPC.** The panel UI talks to the loopback server
  over HTTP/WS; it never talks to the Electron main process. There is therefore
  **no preload bridge** — the empty IPC surface is the minimal attack surface.
  `contextIsolation` on, `nodeIntegration` off, `sandbox` on.
- **No remote content.** The window only ever loads the panel from the
  **loopback origin** `http://127.0.0.1:<port>/`. Any navigation, popup, or
  network request to a non-loopback host is denied by construction
  (`isNavigationAllowed` / `isAllowedPopout` / `isBlockedResource` in
  `src/popout.ts`).
- **Single instance.** `app.requestSingleInstanceLock()`; a second launch
  focuses the first window.

## Why it loads the loopback origin (not `file://`)

The web client is hard-wired **same-origin**: it builds WebSocket URLs from
`location.host` (`packages/web/src/terminal/connectPty.ts`,
`packages/web/src/api/stream.ts`) and opens dockview popouts at the relative
`/popout.html` (`packages/web/src/workspace/DockWorkspace.tsx`). A `file://`
load would give an empty `location.host` (breaking `/ws` and `/pty`) and resolve
popouts to `file:///popout.html`. So the shell loads the UI from the loopback
**server** — which is the web-bundle host in the published product (the bundled
`terminull serve` serves `web-dist`; the dev monorepo server serves a smoke page
and Vite serves the full UI on `:5173`). Loopback is **local** content, not
remote.

## Modes

| Mode        | When                                                                       | What the shell does                                                                                                 |
| ----------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **attach**  | a live server is found via `<stateDir>/server.json` (pid liveness-checked) | load `http://127.0.0.1:<port>/`                                                                                     |
| **managed** | no live server                                                             | spawn `terminull serve` (stdio piped), poll `server.json` until live (15s timeout), load it, kill the child on quit |

When neither yields a server, the window shows an **honest Korean error screen**
(`src/screens.ts`) — never a blank window.

## Security guards (session-wide)

Installed in `installSessionGuards` (`src/main.ts`):

- `onBeforeRequest` → **cancels** any http(s)/ws(s) request to a non-loopback
  host (the load-bearing "no remote content" rule).
- `onBeforeSendHeaders` → **strips `Origin`** for loopback requests so the
  server's `originOk()` always trusts the shell (same trick as the Vite dev
  proxy, `packages/web/vite.config.ts`).
- `onHeadersReceived` → adds a conservative **CSP** when the served response
  carries none.

Plus, per window: `setWindowOpenHandler` allows only same-loopback-host popouts;
`will-navigate` refuses any off-origin navigation.

## Dev run

```sh
pnpm --filter @terminull/desktop dev   # tsc -b && electron .
```

For the full UI in the dev monorepo, run the panel server + Vite and point the
shell at Vite:

```sh
# terminal 1: panel server (binds 127.0.0.1)
pnpm --filter @terminull/server dev
# terminal 2: web UI
pnpm --filter @terminull/web dev
# terminal 3: the shell, pointed at Vite (loopback-guarded override)
TERMINULL_PANEL_URL=http://localhost:5173 pnpm --filter @terminull/desktop dev
```

### Environment overrides

| Var                   | Effect                                                                        |
| --------------------- | ----------------------------------------------------------------------------- |
| `TERMINULL_STATE_DIR` | where `server.json` is discovered (default `~/.terminull`)                    |
| `TERMINULL_PANEL_URL` | load this URL instead of the discovered origin — **honored only if loopback** |
| `TERMINULL_BIN`       | executable used for the managed `… serve` spawn (default `terminull`)         |

## Tests / smoke (gate g)

```sh
pnpm --filter @terminull/desktop test
```

- `src/shell.test.ts` — pure units (attach/managed decision, loopback policy,
  serve-command + poll, screens). Run everywhere, no display needed.
- `src/smoke.test.ts` — spawns the **real** built `dist/main.js` in headless
  smoke mode and asserts the attach/managed decision + single-instance exit
  **without creating a window**. **Honest skip** on `CI && !DISPLAY`, or when
  `dist/main.js` is not built / electron is unresolvable (printed reason, never
  green-faked).

## Packaging: DEFERRED (v0.x)

v0.x ships as a **documented unsigned local build** run from source
(`pnpm --filter @terminull/desktop dev`). There is intentionally **no
electron-builder, no signing, no packaging CI** yet — that lands in a later
milestone.
