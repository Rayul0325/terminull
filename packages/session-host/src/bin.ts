#!/usr/bin/env node
/**
 * `paneld` CLI — start, query, or relay to the session-host daemon.
 *
 *   paneld start  --state-dir <dir> [--foreground]
 *   paneld status --state-dir <dir>
 *   paneld agent  --state-dir <dir> [--no-spawn] [--home <dir>]
 *   paneld agent  --probe
 *
 * `start` runs in the foreground for now (detach/launchd install lands in
 * M10); `--foreground` is accepted so scripts written today keep working then.
 * `status` connects to the daemon's socket, performs the hello handshake with
 * the state dir's token and prints the `helloOk` reply as JSON.
 * `agent` is the M8 remote relay: it bridges its OWN stdin/stdout to the
 * daemon socket (spawning the daemon when dead, unless `--no-spawn`). In agent
 * mode stdout carries ONLY the preamble line + binary frames — every log line
 * goes to stderr. `--home` points the session collector at an alternate home
 * (tests use a tmpdir fake); `--probe` prints the preamble and exits 0 without
 * touching the daemon (enroll verification).
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { AGENT_PREAMBLE, FrameDecoder, FrameEncoder, HOST_PROTO_VERSION } from '@terminull/shared';
import { runAgentRelay } from './agent-relay.js';
import { createAgentCollector } from './collect.js';
import { SessionHost } from './host.js';

function usage(): never {
  console.error(
    'usage: paneld <start|status> --state-dir <dir> [--foreground]\n' +
      '       paneld agent --state-dir <dir> [--no-spawn] [--home <dir>] | paneld agent --probe',
  );
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

async function cmdAgent(stateDir: string, noSpawn: boolean, home: string): Promise<never> {
  // NOTE: agent-mode stdout must stay byte-clean for the frame codec — the
  // relay owns it entirely; this wrapper never writes to stdout itself.
  const code = await runAgentRelay({
    stateDir,
    noSpawn,
    collector: createAgentCollector({ home }),
  });
  process.exit(code);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      'state-dir': { type: 'string' },
      foreground: { type: 'boolean', default: false },
      'no-spawn': { type: 'boolean', default: false },
      probe: { type: 'boolean', default: false },
      home: { type: 'string' },
    },
    allowPositionals: true,
  });
  const command = positionals[0];
  if (command === 'agent' && values.probe) {
    // Enroll verification: prove the launcher + node pin work end to end
    // without touching the daemon. Preamble on stdout, exit 0.
    process.stdout.write(AGENT_PREAMBLE + '\n');
    return;
  }
  const stateDir = values['state-dir'];
  if (!command || !stateDir) usage();

  switch (command) {
    case 'start':
      await cmdStart(stateDir);
      return;
    case 'status':
      await cmdStatus(stateDir);
      return;
    case 'agent':
      await cmdAgent(stateDir, values['no-spawn'], values.home ?? os.homedir());
      return;
    default:
      usage();
  }
}

main().catch((e: unknown) => {
  console.error(`paneld: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
