import { describe, expect, it } from 'vitest';
import { Ring } from '../src/ring';

/** Concatenate a replay result's chunks into one buffer. */
function join(chunks: Buffer[]): Buffer {
  return Buffer.concat(chunks);
}

describe('Ring — basic accounting', () => {
  it('tracks headSeq as total bytes appended', () => {
    const r = new Ring(1024);
    r.append(Buffer.from('abc'));
    r.append(Buffer.from('de'));
    expect(r.headSeq).toBe(5);
    expect(r.tailSeq).toBe(0);
    expect(r.size).toBe(5);
  });

  it('rejects a non-positive capacity', () => {
    expect(() => new Ring(0)).toThrow();
    expect(() => new Ring(-1)).toThrow();
  });

  it('ignores empty appends', () => {
    const r = new Ring(16);
    r.append(Buffer.alloc(0));
    expect(r.headSeq).toBe(0);
  });
});

describe('Ring — replay within the retained window', () => {
  it('replayFrom(recent seq) has gap=false and exact bytes', () => {
    const r = new Ring(1024);
    r.append(Buffer.from('hello '));
    const seqAfterHello = r.headSeq; // 6
    r.append(Buffer.from('world'));
    const res = r.replayFrom(seqAfterHello);
    expect(res.gap).toBe(false);
    expect(res.fromSeq).toBe(6);
    expect(res.headSeq).toBe(11);
    expect(join(res.chunks).toString()).toBe('world');
  });

  it('replayFrom(0) with nothing evicted returns everything, gap=false', () => {
    const r = new Ring(1024);
    r.append(Buffer.from('abcdef'));
    const res = r.replayFrom(0);
    expect(res.gap).toBe(false);
    expect(join(res.chunks).toString()).toBe('abcdef');
  });

  it('replayFrom(headSeq) returns nothing, gap=false', () => {
    const r = new Ring(1024);
    r.append(Buffer.from('abc'));
    const res = r.replayFrom(r.headSeq);
    expect(res.chunks).toHaveLength(0);
    expect(res.gap).toBe(false);
  });

  it('slices mid-chunk correctly', () => {
    const r = new Ring(1024);
    r.append(Buffer.from('0123456789'));
    const res = r.replayFrom(4);
    expect(join(res.chunks).toString()).toBe('456789');
    expect(res.fromSeq).toBe(4);
  });
});

describe('Ring — eviction past capacity', () => {
  it('fill past capacity then replayFrom(0) flags gap=true and returns the tail', () => {
    const r = new Ring(8);
    // Append 12 bytes into an 8-byte ring: seqs 0..11, only [4,12) retained.
    r.append(Buffer.from('AAAA')); // 0..3
    r.append(Buffer.from('BBBB')); // 4..7
    r.append(Buffer.from('CCCC')); // 8..11 -> evicts the first chunk
    expect(r.headSeq).toBe(12);
    expect(r.tailSeq).toBe(4);
    expect(r.size).toBe(8);
    const res = r.replayFrom(0);
    expect(res.gap).toBe(true);
    expect(res.fromSeq).toBe(4);
    expect(res.headSeq).toBe(12);
    expect(join(res.chunks).toString()).toBe('BBBBCCCC');
  });

  it('replayFrom a still-retained seq after eviction has gap=false', () => {
    const r = new Ring(8);
    r.append(Buffer.from('AAAA'));
    r.append(Buffer.from('BBBB'));
    r.append(Buffer.from('CCCC')); // retains [4,12)
    const res = r.replayFrom(8);
    expect(res.gap).toBe(false);
    expect(join(res.chunks).toString()).toBe('CCCC');
  });

  it('partial-trims the oldest chunk when eviction lands mid-chunk', () => {
    const r = new Ring(5);
    r.append(Buffer.from('ABCDE')); // 0..4, full
    r.append(Buffer.from('FG')); // 5..6 -> must drop 2 bytes -> retains [2,7)="CDEFG"
    expect(r.tailSeq).toBe(2);
    expect(r.size).toBe(5);
    const res = r.replayFrom(0);
    expect(res.gap).toBe(true);
    expect(join(res.chunks).toString()).toBe('CDEFG');
  });

  it('handles a single append larger than capacity (keeps the trailing window)', () => {
    const r = new Ring(4);
    r.append(Buffer.from('0123456789')); // 10 bytes into a 4-byte ring
    expect(r.headSeq).toBe(10);
    expect(r.size).toBe(4);
    expect(r.tailSeq).toBe(6);
    const res = r.replayFrom(0);
    expect(res.gap).toBe(true);
    expect(join(res.chunks).toString()).toBe('6789');
  });
});
