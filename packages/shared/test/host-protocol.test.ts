import { describe, expect, it } from 'vitest';
import {
  ClientControlSchema,
  FrameDecoder,
  FrameEncoder,
  FrameError,
  HostControlSchema,
  type DecodedFrame,
} from '../src/index';

/** Drain a decoder for one buffer and return the frames. */
function decodeAll(dec: FrameDecoder, buf: Buffer): DecodedFrame[] {
  return dec.push(buf);
}

describe('frame codec — CTRL roundtrip', () => {
  it('roundtrips a client hello and validates against the client schema', () => {
    const msg = { t: 'hello', proto: 1, token: 'sekret' } as const;
    const frame = FrameEncoder.ctrl(msg);
    const [decoded] = decodeAll(new FrameDecoder(), frame);
    expect(decoded?.kind).toBe('ctrl');
    if (decoded?.kind !== 'ctrl') throw new Error('expected ctrl');
    expect(ClientControlSchema.parse(decoded.json)).toEqual(msg);
  });

  it('roundtrips a host helloOk and validates against the host schema', () => {
    const msg = {
      t: 'helloOk',
      proto: 1,
      hostId: 'host-1',
      bootId: 'boot-1',
      sessions: [],
    } as const;
    const [decoded] = decodeAll(new FrameDecoder(), FrameEncoder.ctrl(msg));
    if (decoded?.kind !== 'ctrl') throw new Error('expected ctrl');
    expect(HostControlSchema.parse(decoded.json)).toEqual(msg);
  });
});

describe('frame codec — OUT/IN roundtrip', () => {
  it('roundtrips an OUT frame preserving sid, seq (bigint) and raw bytes', () => {
    const data = Buffer.from([0x1b, 0x5b, 0x30, 0x6d, 0xff, 0x00, 0x41]); // includes non-utf8 bytes
    const [decoded] = decodeAll(new FrameDecoder(), FrameEncoder.out(7, 123_456_789_012n, data));
    if (decoded?.kind !== 'out') throw new Error('expected out');
    expect(decoded.sid).toBe(7);
    expect(decoded.seq).toBe(123_456_789_012n);
    expect(Buffer.compare(decoded.data, data)).toBe(0);
  });

  it('roundtrips an IN frame', () => {
    const data = Buffer.from('ls -la\r');
    const [decoded] = decodeAll(new FrameDecoder(), FrameEncoder.input(42, data));
    if (decoded?.kind !== 'in') throw new Error('expected in');
    expect(decoded.sid).toBe(42);
    expect(decoded.data.toString()).toBe('ls -la\r');
  });

  it('roundtrips an empty-data OUT frame', () => {
    const [decoded] = decodeAll(new FrameDecoder(), FrameEncoder.out(1, 0n, Buffer.alloc(0)));
    if (decoded?.kind !== 'out') throw new Error('expected out');
    expect(decoded.data.length).toBe(0);
  });
});

describe('frame codec — stream safety', () => {
  it('reassembles a frame delivered in single-byte partial chunks', () => {
    const frame = FrameEncoder.ctrl({ t: 'list', reqId: 'r1' });
    const dec = new FrameDecoder();
    const collected: DecodedFrame[] = [];
    for (let i = 0; i < frame.length; i++) {
      collected.push(...dec.push(frame.subarray(i, i + 1)));
    }
    expect(collected).toHaveLength(1);
    expect(collected[0]?.kind).toBe('ctrl');
  });

  it('splits two frames coalesced into one chunk', () => {
    const a = FrameEncoder.ctrl({ t: 'list', reqId: 'a' });
    const b = FrameEncoder.out(3, 9n, Buffer.from('xy'));
    const frames = decodeAll(new FrameDecoder(), Buffer.concat([a, b]));
    expect(frames).toHaveLength(2);
    expect(frames[0]?.kind).toBe('ctrl');
    expect(frames[1]?.kind).toBe('out');
  });

  it('handles a header split across chunks then the body split again', () => {
    const frame = FrameEncoder.out(2, 5n, Buffer.from('hello-world'));
    const dec = new FrameDecoder();
    // 3 bytes (partial header), then 4 bytes (rest of header + 2 body), then rest.
    const out: DecodedFrame[] = [];
    out.push(...dec.push(frame.subarray(0, 3)));
    out.push(...dec.push(frame.subarray(3, 7)));
    out.push(...dec.push(frame.subarray(7)));
    expect(out).toHaveLength(1);
    if (out[0]?.kind !== 'out') throw new Error('expected out');
    expect(out[0].data.toString()).toBe('hello-world');
  });

  it('carries three coalesced frames of mixed kinds in order', () => {
    const frames = decodeAll(
      new FrameDecoder(),
      Buffer.concat([
        FrameEncoder.ctrl({ t: 'detach', sid: 1 }),
        FrameEncoder.input(1, Buffer.from('a')),
        FrameEncoder.out(1, 1n, Buffer.from('b')),
      ]),
    );
    expect(frames.map((f) => f.kind)).toEqual(['ctrl', 'in', 'out']);
  });
});

describe('frame codec — hostile input', () => {
  it('throws FrameError when a declared body length exceeds the cap', () => {
    const dec = new FrameDecoder({ maxBodyLen: 8 });
    const bad = Buffer.alloc(5);
    bad.writeUInt32LE(9, 0); // 9 > 8
    bad.writeUInt8(0x01, 4);
    expect(() => dec.push(bad)).toThrow(FrameError);
  });

  it('throws on an unknown frame kind', () => {
    const bad = Buffer.alloc(5);
    bad.writeUInt32LE(0, 0);
    bad.writeUInt8(0x09, 4);
    expect(() => new FrameDecoder().push(bad)).toThrow(FrameError);
  });
});
