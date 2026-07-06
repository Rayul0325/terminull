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
export interface ServeDeps {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

/** Start the panel server and block until the process is signalled. */
export async function runServe(
  values: { stateDir: string; host?: string; port?: number },
  deps: ServeDeps,
): Promise<number> {
  const { createTerminullServer } = await import('@terminull/server');
  const host = values.host ?? '127.0.0.1';
  const server = createTerminullServer({
    stateDir: values.stateDir,
    host,
    ...(values.port !== undefined ? { port: values.port } : {}),
  });
  try {
    const { port } = await server.listen();
    deps.stdout(`terminull panel listening on http://${host}:${port} (state: ${values.stateDir})`);
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
