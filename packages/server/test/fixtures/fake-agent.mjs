#!/usr/bin/env node
/**
 * Scripted fake agent — the MachineManager unit-test stand-in for the real
 * `paneld agent` relay (contract §8 B2). Speaks the agent stdio contract:
 * preamble line, then binary frames; answers hello/list/spawn/attach/collect
 * and echoes IN bytes back as OUT frames. NEVER dials anything — it is the
 * whole "remote machine" in one local child process.
 *
 * Flags (argv, so no env leakage between parallel tests):
 *   --noise           print MOTD-style noise BEFORE the preamble (discard test)
 *   --die             exit(3) immediately without a preamble (dial_failed test)
 *   --boot-id=<id>    stable bootId across respawns (resumed detection test)
 *   --ignore-list     never answer `list` (heartbeat timeout test)
 *   --collect-sessions answer collect with one fake remote adapter session
 *   --session=<sid>   advertise one pre-existing running session in helloOk
 *   --fail-spawn      answer `spawn` with a ctrl error (host detail test)
 *   --attach-delay=<ms> delay every `attached` reply (mid-dial close test)
 *   --pid-dir=<dir>   write `<dir>/<pid>` at boot (relay child census test)
 *   --stderr=<msg>    write one line to stderr at boot (stderr sink test)
 *   --spawn-sid=<sid> spawn replies with this FIXED sid — pair with
 *                     --session=<sid> so fresh relay children (separate
 *                     processes, separate session maps) can attach to it
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { setTimeout } from 'node:timers';
import {
  AGENT_PREAMBLE,
  FrameDecoder,
  FrameEncoder,
} from '@terminull/shared';

const args = new Set(process.argv.slice(2));
const argValue = (name) => {
  for (const a of args) if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
  return null;
};

if (args.has('--die')) process.exit(3);
const pidDir = argValue('--pid-dir');
if (pidDir !== null) fs.writeFileSync(path.join(pidDir, String(process.pid)), '');
const stderrMsg = argValue('--stderr');
if (stderrMsg !== null) process.stderr.write(`${stderrMsg}\n`);
if (args.has('--noise')) process.stdout.write('Welcome to fake-remote!\nmotd noise line\n');
process.stdout.write(`${AGENT_PREAMBLE}\n`);
const attachDelayMs = Number(argValue('--attach-delay') ?? '0');

const bootId = argValue('--boot-id') ?? `boot-${process.pid}-${Date.now()}`;
const advertised = argValue('--session');
const sessions = new Map();
if (advertised !== null) {
  sessions.set(Number(advertised), {
    sid: Number(advertised),
    cmd: 'sh',
    args: [],
    cols: 80,
    rows: 24,
    owned: true,
    running: true,
    headSeq: 0,
    meta: {},
  });
}
let nextSid = 100;
let outSeq = 0n;

const ctrl = (msg) => process.stdout.write(FrameEncoder.ctrl(msg));
const decoder = new FrameDecoder();

process.stdin.on('data', (chunk) => {
  let frames;
  try {
    frames = decoder.push(chunk);
  } catch {
    process.exit(4);
  }
  for (const frame of frames) {
    if (frame.kind === 'in') {
      // Echo IN bytes back as OUT (byte round-trip through the transport).
      outSeq += BigInt(frame.data.length);
      process.stdout.write(FrameEncoder.out(frame.sid, outSeq, frame.data));
      continue;
    }
    if (frame.kind !== 'ctrl') continue;
    const msg = frame.json;
    switch (msg.t) {
      case 'hello':
        ctrl({ t: 'helloOk', proto: 1, hostId: 'fake-host', bootId, sessions: [...sessions.values()] });
        break;
      case 'list':
        if (args.has('--ignore-list')) break; // scripted silence — heartbeat test
        ctrl({ t: 'sessions', reqId: msg.reqId, sessions: [...sessions.values()] });
        break;
      case 'spawn': {
        if (args.has('--fail-spawn')) {
          ctrl({ t: 'error', reqId: msg.reqId, code: 'SPAWN_FAILED', msg: 'posix_spawnp failed: /usr/bin/zsh not found on host' });
          break;
        }
        const fixedSid = argValue('--spawn-sid');
        const sid = fixedSid !== null ? Number(fixedSid) : nextSid++;
        sessions.set(sid, {
          sid,
          label: msg.spec.label,
          cmd: msg.spec.cmd,
          args: msg.spec.args ?? [],
          cols: msg.spec.cols,
          rows: msg.spec.rows,
          pid: 9999,
          owned: true,
          running: true,
          headSeq: 0,
          meta: msg.spec.meta ?? {},
        });
        ctrl({ t: 'spawned', reqId: msg.reqId, sid, pid: 9999 });
        break;
      }
      case 'attach': {
        if (!sessions.has(msg.sid)) {
          ctrl({ t: 'error', reqId: msg.reqId, code: 'NOT_FOUND', msg: 'no such sid' });
          break;
        }
        const attached = () =>
          ctrl({ t: 'attached', reqId: msg.reqId, sid: msg.sid, fromSeq: 0, headSeq: 0, gap: false });
        if (attachDelayMs > 0) setTimeout(attached, attachDelayMs);
        else attached();
        break;
      }
      case 'kill': {
        const s = sessions.get(msg.sid);
        if (s) {
          s.running = false;
          ctrl({ t: 'exit', sid: msg.sid, code: 0, signal: null });
        }
        break;
      }
      case 'collect':
        if (args.has('--collect-sessions')) {
          ctrl({
            t: 'collected',
            reqId: msg.reqId,
            supported: true,
            adapters: [{ adapterId: 'claude', ok: true, sessions: 1 }],
            sessions: [{ id: 'remote-claude-1', tool: 'claude', live: false, title: 'fake remote' }],
          });
        } else {
          ctrl({
            t: 'collected',
            reqId: msg.reqId,
            supported: false,
            reason: 'collectors_unavailable',
            adapters: [],
            sessions: [],
          });
        }
        break;
      default:
        break; // relay passthrough semantics: unknown ctrl is not an error
    }
  }
});
process.stdin.on('end', () => process.exit(0));
