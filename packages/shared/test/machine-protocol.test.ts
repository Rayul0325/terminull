import { describe, expect, it } from 'vitest';
import {
  AGENT_PREAMBLE,
  AgentClientControlSchema,
  AgentHostControlSchema,
  ClientControlSchema,
  CollectedSchema,
  DEFAULT_REMOTE_AGENT_CMD,
  FrameEncoder,
  FrameError,
  FrameSplitter,
  HostControlSchema,
  LOCAL_MACHINE_ID,
  MachineConfigSchema,
  MachinesFileSchema,
  MAX_UNIX_SOCKET_PATH,
  RemoteSessionSchema,
  SocketPathTooLongError,
  TransportSpecSchema,
  assertSocketPathOk,
  sshSpecToStdio,
} from '../src/index';

describe('TransportSpecSchema', () => {
  it('accepts a stdio spec and defaults args to []', () => {
    const spec = TransportSpecSchema.parse({ kind: 'stdio', cmd: 'node' });
    expect(spec).toEqual({ kind: 'stdio', cmd: 'node', args: [] });
  });

  it('accepts an ssh spec and rejects extra keys (strict)', () => {
    expect(TransportSpecSchema.parse({ kind: 'ssh', host: 'home' })).toEqual({
      kind: 'ssh',
      host: 'home',
      sshArgs: [],
    });
    expect(TransportSpecSchema.safeParse({ kind: 'ssh', host: 'home', port: 22 }).success).toBe(
      false,
    );
  });

  it('rejects unknown kinds — no TCP/listening transports in v1', () => {
    for (const kind of ['tcp', 'tls', 'unix', 'tailscale']) {
      expect(TransportSpecSchema.safeParse({ kind, host: 'x' }).success).toBe(false);
    }
  });
});

describe('sshSpecToStdio', () => {
  it('compiles to a non-interactive BatchMode ssh spawn with the default agent cmd', () => {
    const stdio = sshSpecToStdio({ kind: 'ssh', host: 'user@box', sshArgs: [] });
    expect(stdio.cmd).toBe('ssh');
    expect(stdio.args).toEqual(['-T', '-o', 'BatchMode=yes', 'user@box', DEFAULT_REMOTE_AGENT_CMD]);
  });

  it('places extra sshArgs before the destination and honours remoteCmd', () => {
    const stdio = sshSpecToStdio({
      kind: 'ssh',
      host: 'box',
      remoteCmd: '/opt/agent',
      sshArgs: ['-o', 'ServerAliveInterval=5'],
    });
    expect(stdio.args).toEqual([
      '-T',
      '-o',
      'BatchMode=yes',
      '-o',
      'ServerAliveInterval=5',
      'box',
      '/opt/agent',
    ]);
  });
});

describe('MachineConfigSchema / MachinesFileSchema', () => {
  const transport = { kind: 'stdio', cmd: 'node', args: [] } as const;

  it('accepts a machine and defaults enabled to true', () => {
    const cfg = MachineConfigSchema.parse({ id: 'mars', label: 'Mars', transport });
    expect(cfg.enabled).toBe(true);
  });

  it(`rejects the reserved id '${LOCAL_MACHINE_ID}'`, () => {
    const r = MachineConfigSchema.safeParse({ id: LOCAL_MACHINE_ID, label: 'x', transport });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.message === 'machine_id_reserved')).toBe(true);
    }
  });

  it('rejects non-slug ids', () => {
    for (const id of ['Mars', 'a b', '-x', '', 'x'.repeat(33)]) {
      expect(MachineConfigSchema.safeParse({ id, label: 'x', transport }).success).toBe(false);
    }
  });

  it('rejects duplicate ids in machines.json', () => {
    const r = MachinesFileSchema.safeParse({
      version: 1,
      machines: [
        { id: 'mars', label: 'A', transport },
        { id: 'mars', label: 'B', transport },
      ],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.message === 'machine_id_duplicate')).toBe(true);
    }
  });
});

describe('remote-collect CTRL vocabulary', () => {
  it('collect/collected round-trip through the AGENT unions', () => {
    expect(AgentClientControlSchema.parse({ t: 'collect', reqId: 'r1' })).toEqual({
      t: 'collect',
      reqId: 'r1',
    });
    const collected = {
      t: 'collected',
      reqId: 'r1',
      supported: true,
      adapters: [{ adapterId: 'claude', ok: true, sessions: 1 }],
      sessions: [{ id: 's1', tool: 'claude', live: false, cwd: '/w' }],
    };
    expect(AgentHostControlSchema.parse(collected)).toEqual(collected);
  });

  it('honest-unsupported reply is representable (reason code, empty lists)', () => {
    const reply = CollectedSchema.parse({
      t: 'collected',
      reqId: 'r2',
      supported: false,
      reason: 'collectors_unavailable',
      adapters: [],
      sessions: [],
    });
    expect(reply.supported).toBe(false);
    expect(reply.reason).toBe('collectors_unavailable');
  });

  it('plain paneld unions REJECT collect/collected (relay-terminated only)', () => {
    expect(ClientControlSchema.safeParse({ t: 'collect', reqId: 'r' }).success).toBe(false);
    expect(
      HostControlSchema.safeParse({
        t: 'collected',
        reqId: 'r',
        supported: true,
        adapters: [],
        sessions: [],
      }).success,
    ).toBe(false);
  });

  it('agent unions still accept the full paneld vocabulary', () => {
    expect(AgentClientControlSchema.parse({ t: 'hello', proto: 1, token: '' }).t).toBe('hello');
    expect(AgentHostControlSchema.parse({ t: 'exit', sid: 1, code: 0 }).t).toBe('exit');
  });

  it('RemoteSessionSchema is strict and has no transcriptRef in v1', () => {
    expect(
      RemoteSessionSchema.safeParse({
        id: 's',
        tool: 'claude',
        live: false,
        transcriptRef: { kind: 'jsonl', path: '/x' },
      }).success,
    ).toBe(false);
  });
});

describe('FrameSplitter', () => {
  it('yields byte-identical raw frames across coalesced + partial chunks', () => {
    const f1 = FrameEncoder.ctrl({ t: 'list', reqId: 'a' });
    const f2 = FrameEncoder.out(3, 7n, Buffer.from('hello'));
    const joined = Buffer.concat([f1, f2]);
    const splitter = new FrameSplitter();
    const first = splitter.push(joined.subarray(0, f1.length + 3));
    expect(first).toHaveLength(1);
    expect(first[0]?.equals(f1)).toBe(true);
    const rest = splitter.push(joined.subarray(f1.length + 3));
    expect(rest).toHaveLength(1);
    expect(rest[0]?.equals(f2)).toBe(true);
  });

  it('throws FrameError on an oversize declared body (hostile stream)', () => {
    const splitter = new FrameSplitter({ maxBodyLen: 8 });
    const header = Buffer.alloc(5);
    header.writeUInt32LE(9, 0);
    header.writeUInt8(1, 4);
    expect(() => splitter.push(header)).toThrow(FrameError);
  });
});

describe('assertSocketPathOk', () => {
  it('passes short paths and throws a coded error on long ones', () => {
    expect(() => assertSocketPathOk('/tmp/tn/host.sock')).not.toThrow();
    const long = '/' + 'a'.repeat(MAX_UNIX_SOCKET_PATH) + '/host.sock';
    expect(() => assertSocketPathOk(long)).toThrow(SocketPathTooLongError);
    try {
      assertSocketPathOk(long);
    } catch (e) {
      expect((e as SocketPathTooLongError).code).toBe('socket_path_too_long');
    }
  });

  it('counts BYTES, not code units (multi-byte paths)', () => {
    const hangul = '/tmp/' + '한'.repeat(34); // 5 + 102 bytes > 103, but only 39 chars
    expect(() => assertSocketPathOk(hangul)).toThrow(SocketPathTooLongError);
  });
});

describe('agent preamble', () => {
  it('is a single stable line token', () => {
    expect(AGENT_PREAMBLE).toBe('TERMINULL-AGENT-1');
    expect(AGENT_PREAMBLE.includes('\n')).toBe(false);
  });
});
