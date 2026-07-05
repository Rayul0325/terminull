#!/usr/bin/env node
/**
 * `paneld` CLI — start or query the session-host daemon.
 *
 *   paneld start  --state-dir <dir> [--foreground]
 *   paneld status --state-dir <dir>
 *
 * `start` runs in the foreground for now (detach/launchd install lands in
 * M10); `--foreground` is accepted so scripts written today keep working then.
 * `status` connects to the daemon's socket, performs the hello handshake with
 * the state dir's token and prints the `helloOk` reply as JSON.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { FrameDecoder, FrameEncoder, HOST_PROTO_VERSION } from '@terminull/shared';
import { SessionHost } from './host.js';

function usage(): never {
  console.error('usage: paneld <start|status> --state-dir <dir> [--foreground]');
  process.exit(2);
}

async function cmdStart(stateDir: string): Promise<void> {
  const host = new SessionHost({ stateDir });
  await host.start();
  console.log(`paneld listening on ${host.socketPath} (hostId=${host.hostId})`);
  const shutdown = (signal: NodeJS.Signals): void => {
    console.log(`paneld: ${signal} received, shutting down`);
    host.stop(); // kills PTY children and closes the socket
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

async function cmdStatus(stateDir: string): Promise<void> {
  const tokenFile = path.join(stateDir, 'host-token');
  if (!fs.existsSync(tokenFile)) {
    console.error(`paneld: no token at ${tokenFile} — is the daemon initialised?`);
    process.exit(1);
  }
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  const socketPath = path.join(stateDir, 'host.sock');

  const helloOk = await new Promise<unknown>((resolve, reject) => {
    const socket = net.connect(socketPath);
    const decoder = new FrameDecoder();
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('timed out waiting for helloOk'));
    }, 5000);
    socket.on('connect', () => {
      socket.write(FrameEncoder.ctrl({ t: 'hello', proto: HOST_PROTO_VERSION, token }));
    });
    socket.on('data', (chunk) => {
      for (const frame of decoder.push(chunk)) {
        if (frame.kind !== 'ctrl') continue;
        clearTimeout(timer);
        socket.end();
        const msg = frame.json as { t?: string; msg?: string };
        if (msg.t === 'helloOk') resolve(frame.json);
        else reject(new Error(`daemon replied ${msg.t ?? 'unknown'}: ${msg.msg ?? ''}`));
        return;
      }
    });
    socket.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });

  console.log(JSON.stringify(helloOk, null, 2));
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      'state-dir': { type: 'string' },
      foreground: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });
  const command = positionals[0];
  const stateDir = values['state-dir'];
  if (!command || !stateDir) usage();

  switch (command) {
    case 'start':
      await cmdStart(stateDir);
      return;
    case 'status':
      await cmdStatus(stateDir);
      return;
    default:
      usage();
  }
}

main().catch((e: unknown) => {
  console.error(`paneld: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
