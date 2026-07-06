/**
 * `terminull serve` — host the local panel server (what the launchd service
 * runs). The server graph is pulled in via a DYNAMIC import so the rest of the
 * CLI keeps its lean layering (the dev CLI otherwise avoids a static
 * `@terminull/server` dependency — see machines-file.ts); at pack time tsup
 * inlines the imported server code into the single bundle (contract §D1), so
 * the published `terminull` needs no separate server install.
 *
 * Binds 127.0.0.1 by default; a non-loopback host is the operator's explicit
 * choice and is passed straight through to the server's own bind guard.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ServeDeps {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

/** A resolved web-panel bundle + the layout it was found in. */
export interface ResolvedUi {
  dir: string;
  layout: 'packed' | 'dev';
}

/**
 * Resolve the built web-panel bundle for BOTH shipping layouts, relative to
 * this module's directory:
 *  - published tarball: `<pkg>/web-dist` — a sibling of the `dist-pack/` bundle
 *    this code is inlined into (prepack copies packages/web/dist there);
 *  - dev monorepo: `packages/web/dist` — two levels up from `packages/cli/{src,dist}`
 *    (after `pnpm --filter @terminull/web build`).
 * Returns the first candidate that actually holds an index.html, else null so
 * the server degrades to its honest smoke-page fallback.
 */
export function resolveUiDir(fromDir: string): ResolvedUi | null {
  const candidates: ResolvedUi[] = [
    { dir: path.join(fromDir, '..', 'web-dist'), layout: 'packed' },
    { dir: path.join(fromDir, '..', '..', 'web', 'dist'), layout: 'dev' },
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c.dir, 'index.html'))) {
      return { dir: path.resolve(c.dir), layout: c.layout };
    }
  }
  return null;
}

/** Start the panel server and block until the process is signalled. */
export async function runServe(
  values: { stateDir: string; host?: string; port?: number },
  deps: ServeDeps,
): Promise<number> {
  const { createTerminullServer } = await import('@terminull/server');
  const host = values.host ?? '127.0.0.1';
  const ui = resolveUiDir(path.dirname(fileURLToPath(import.meta.url)));
  const server = createTerminullServer({
    stateDir: values.stateDir,
    host,
    ...(values.port !== undefined ? { port: values.port } : {}),
    ...(ui ? { uiDir: ui.dir } : {}),
  });
  try {
    const { port } = await server.listen();
    deps.stdout(`terminull panel listening on http://${host}:${port} (state: ${values.stateDir})`);
    deps.stdout(
      ui
        ? `serving web UI from ${ui.dir} (${ui.layout} layout)`
        : 'no web UI bundle found — serving the smoke fallback at / ' +
            '(build packages/web to serve the real panel)',
    );
  } catch (err) {
    deps.stderr(`panel failed to start: ${(err as Error).message}`);
    return 1;
  }

  const shutdown = (signal: NodeJS.Signals): void => {
    deps.stdout(`terminull serve: ${signal} received, shutting down`);
    void server.close().then(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  // Run until the service manager (or a signal) stops us.
  await new Promise<never>(() => {});
  return 0;
}
