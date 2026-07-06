#!/usr/bin/env node
/**
 * `terminull-server` CLI.
 *
 *   terminull-server start [--state-dir <dir>] [--port <n>] [--host <addr>]
 *                          [--unsafe-bind]
 *
 * Defaults: state dir `~/.terminull`, host 127.0.0.1, port 7420. Binding a
 * wildcard address is refused without `--unsafe-bind` (see the threat-model
 * warning below); a specific non-loopback host prints the warning but runs.
 */
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { DEFAULT_HOST, DEFAULT_PORT, UnsafeBindError, createTerminullServer } from './app.js';

function usage(): never {
  console.error(
    'usage: terminull-server start [--state-dir <dir>] [--port <n>] [--host <addr>] [--unsafe-bind]',
  );
  process.exit(2);
}

const THREAT_WARNING = [
  'WARNING: binding a non-loopback address exposes session control, PTY input',
  'and the event log to the network. Anyone who can reach this port and read',
  'the token can drive your terminals. Bind loopback + use a tunnel (SSH,',
  'Tailscale) unless you fully control the network.',
  '경고: 루프백이 아닌 주소로 열면 이 포트에 접근 가능한 누구나 토큰만 얻으면',
  '터미널 세션을 조종할 수 있습니다. 가능하면 127.0.0.1 + 터널(SSH/Tailscale)을 쓰세요.',
].join('\n');

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      'state-dir': { type: 'string' },
      port: { type: 'string' },
      host: { type: 'string' },
      'unsafe-bind': { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });
  if (positionals[0] !== 'start') usage();

  const stateDir = values['state-dir'] ?? path.join(os.homedir(), '.terminull');
  const host = values.host ?? DEFAULT_HOST;
  const port = values.port !== undefined ? Number(values.port) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) usage();

  const loopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';
  if (!loopback) console.error(THREAT_WARNING);

  const server = createTerminullServer({
    stateDir,
    host,
    port,
    unsafeBind: values['unsafe-bind'] ?? false,
  });

  try {
    const { port: bound } = await server.listen();
    console.log(`terminull-server listening on http://${host}:${bound} (state: ${stateDir})`);
  } catch (e) {
    if (e instanceof UnsafeBindError) {
      console.error(THREAT_WARNING);
      console.error(`refused: ${e.message}`);
      process.exit(2);
    }
    throw e;
  }

  // Degrade, never crash: a route bug must not take every session view down.
  process.on('uncaughtException', (e) => {
    console.error(`uncaught: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  });
  process.on('unhandledRejection', (e) => {
    console.error(`unhandled rejection: ${e instanceof Error ? e.message : String(e)}`);
  });

  const shutdown = (signal: NodeJS.Signals): void => {
    console.log(`terminull-server: ${signal} received, shutting down`);
    void server.close().then(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e: unknown) => {
  console.error(`terminull-server: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
