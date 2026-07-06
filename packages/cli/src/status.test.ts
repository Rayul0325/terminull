/**
 * `terminull machines` status tests — a real http server on 127.0.0.1:0 plays
 * the panel server; the "server down" paths use tmpdir state dirs only.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import type { MachineStateDto } from '@terminull/shared';
import { saveMachinesFile } from './machines-file';
import { machinesStatus, renderStatusLines } from './status';

const tmpdirs: string[] = [];
const servers: http.Server[] = [];

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn8cli-st-'));
  tmpdirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise((resolve) => server.close(resolve));
  }
  for (const dir of tmpdirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function writeDiscovery(stateDir: string, port: number, pid: number): void {
  fs.writeFileSync(path.join(stateDir, 'server.json'), JSON.stringify({ port, pid }));
}

function listen(handler: http.RequestListener): Promise<number> {
  const server = http.createServer(handler);
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr !== null ? addr.port : 0);
    });
  });
}

describe('machinesStatus', () => {
  it('reports config-only honestly when no server was ever started', async () => {
    const state = tmp();
    saveMachinesFile(state, [
      { id: 'mars', label: 'Mars', transport: { kind: 'ssh', host: 'mars' }, enabled: true },
    ]);
    const status = await machinesStatus(state);
    expect(status.source).toBe('config');
    if (status.source === 'config') {
      expect(status.reason).toBe('server_down');
      expect(status.machines.map((m) => m.id)).toEqual(['mars']);
    }
  });

  it('treats a stale discovery file (dead pid) as server down', async () => {
    const state = tmp();
    // A pid that certainly exited: our own short-lived child.
    const dead = spawnSync(process.execPath, ['-e', '0']);
    writeDiscovery(state, 1, dead.pid ?? 999999);
    const status = await machinesStatus(state);
    expect(status.source).toBe('config');
    if (status.source === 'config') expect(status.reason).toBe('server_down');
  });

  it('returns live states from a running server', async () => {
    const state = tmp();
    const dto: MachineStateDto = {
      id: 'mars',
      label: 'Mars',
      state: 'stale',
      lastSeenAt: 1751700000000,
    };
    const port = await listen((req, res) => {
      if (req.url === '/api/machines') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ machines: [dto] }));
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    writeDiscovery(state, port, process.pid);
    const status = await machinesStatus(state);
    expect(status.source).toBe('server');
    if (status.source === 'server') {
      expect(status.machines).toEqual([dto]);
      expect(status.port).toBe(port);
    }
  });

  it('falls back honestly when the server lacks the machines API', async () => {
    const state = tmp();
    saveMachinesFile(state, [
      { id: 'mars', label: 'Mars', transport: { kind: 'ssh', host: 'mars' }, enabled: true },
    ]);
    const port = await listen((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    writeDiscovery(state, port, process.pid);
    const status = await machinesStatus(state);
    expect(status.source).toBe('config');
    if (status.source === 'config') {
      expect(status.reason).toBe('no_machines_api');
      expect(status.machines).toHaveLength(1);
    }
  });
});

describe('renderStatusLines', () => {
  it('renders live stale state with its lastSeen timestamp, never a fake green', () => {
    const lines = renderStatusLines({
      source: 'server',
      port: 7420,
      machines: [
        { id: 'mars', label: 'Mars', state: 'stale', lastSeenAt: 1751700000000 },
        { id: 'venus', label: 'Venus', state: 'connecting', lastSeenAt: null },
      ],
    });
    const joined = lines.join('\n');
    expect(joined).toContain('응답 없음');
    expect(joined).toContain(new Date(1751700000000).toLocaleString());
    expect(joined).toContain('연결 중');
    expect(joined).not.toContain('연결됨');
  });

  it('marks config-sourced rows as config-only, not as connection states', () => {
    const lines = renderStatusLines({
      source: 'config',
      reason: 'server_down',
      machines: [
        { id: 'mars', label: 'Mars', transport: { kind: 'ssh', host: 'mars' }, enabled: true },
      ],
    });
    expect(lines.join('\n')).toContain('설정만');
  });
});
