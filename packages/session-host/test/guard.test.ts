/**
 * A1/A2 guards: the AF_UNIX socket-path length check must reject BEFORE any
 * filesystem side effect (known live failure: macOS caps sun_path at 104
 * bytes and fails bind(2) with a baffling EINVAL), and host.pid must exist
 * exactly while the daemon runs.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_UNIX_SOCKET_PATH } from '@terminull/shared';
import { SessionHost } from '../src/host';

let base: string;

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('socket path length guard (A1)', () => {
  it('start() rejects a >103-byte socket path with the coded error, no side effects', async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'paneld-guard-'));
    // Byte-counted budget: pad well past the cap regardless of tmpdir length.
    const longDir = path.join(base, 'x'.repeat(MAX_UNIX_SOCKET_PATH));
    const host = new SessionHost({ stateDir: longDir });
    expect(Buffer.byteLength(host.socketPath, 'utf8')).toBeGreaterThan(MAX_UNIX_SOCKET_PATH);

    await expect(host.start()).rejects.toMatchObject({ code: 'socket_path_too_long' });
    // Guard fired before ANY filesystem work: no socket, no state dir at all.
    expect(fs.existsSync(host.socketPath)).toBe(false);
    expect(fs.existsSync(longDir)).toBe(false);
  });
});

describe('host.pid lifecycle (A2)', () => {
  it('exists (0600, own pid) while running; removed on clean stop', async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'paneld-pid-'));
    const host = new SessionHost({ stateDir: base });
    await host.start();
    try {
      expect(fs.existsSync(host.pidPath)).toBe(true);
      expect(fs.readFileSync(host.pidPath, 'utf8').trim()).toBe(String(process.pid));
      expect(fs.statSync(host.pidPath).mode & 0o777).toBe(0o600);
    } finally {
      host.stop();
    }
    expect(fs.existsSync(host.pidPath)).toBe(false);
  });
});
