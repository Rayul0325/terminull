/**
 * Per-session output ring buffer.
 *
 * A session's PTY output is a byte stream. Each byte has a monotonically
 * increasing `seq` (its offset from the very first byte the session ever
 * emitted). The ring retains only the most recent `capacity` bytes so a
 * reconnecting client can replay recent scrollback; older bytes fall out.
 *
 * `seq` semantics: `headSeq` is one-past the newest byte (== total bytes ever
 * appended). `tailSeq` is the seq of the oldest byte still retained. A client
 * that has consumed output up to `X` reconnects with `sinceSeq: X`; the ring
 * returns bytes `[X, headSeq)` — unless `X < tailSeq`, in which case it returns
 * everything it still has and flags `gap: true`.
 */

/** Default ring capacity: 4 MiB of scrollback per session. */
export const DEFAULT_RING_BYTES = 4 * 1024 * 1024;

/** Result of {@link Ring.replayFrom}. */
export interface ReplayResult {
  /** Retained bytes from `fromSeq` onward, in order. */
  chunks: Buffer[];
  /** True when the requested seq predated the ring; `fromSeq` was clamped up. */
  gap: boolean;
  /** Seq of the first returned byte (== requested seq unless a gap clamped it). */
  fromSeq: number;
  /** Ring head at call time (one-past the newest byte). */
  headSeq: number;
}

interface StoredChunk {
  /** Seq of this chunk's first byte. */
  seq: number;
  data: Buffer;
}

export class Ring {
  readonly capacity: number;

  private chunks: StoredChunk[] = [];
  private bytes = 0; // total retained bytes across `chunks`
  private tail = 0; // seq of oldest retained byte
  private head = 0; // seq one-past newest byte (== total ever appended)

  constructor(capacityBytes: number = DEFAULT_RING_BYTES) {
    if (!Number.isInteger(capacityBytes) || capacityBytes <= 0) {
      throw new Error(`ring capacity must be a positive integer, got ${capacityBytes}`);
    }
    this.capacity = capacityBytes;
  }

  /** One-past the newest byte's seq (total bytes ever appended). */
  get headSeq(): number {
    return this.head;
  }

  /** Seq of the oldest byte still retained. */
  get tailSeq(): number {
    return this.tail;
  }

  /** Bytes currently retained (<= capacity). */
  get size(): number {
    return this.bytes;
  }

  /**
   * Append output bytes. `headSeq` always advances by the full input length
   * (seq accounting must match the real byte stream), even if eviction then
   * trims the oldest retained bytes.
   */
  append(data: Buffer): void {
    if (data.length === 0) return;
    // Copy: the caller may reuse its buffer after we return.
    this.chunks.push({ seq: this.head, data: Buffer.from(data) });
    this.bytes += data.length;
    this.head += data.length;
    this.evict();
  }

  private evict(): void {
    while (this.bytes > this.capacity) {
      const first = this.chunks[0];
      if (!first) break;
      const excess = this.bytes - this.capacity;
      if (first.data.length <= excess) {
        this.bytes -= first.data.length;
        this.chunks.shift();
        this.tail = this.chunks[0]?.seq ?? this.head;
      } else {
        // Trim the front of the oldest chunk rather than drop it whole.
        first.data = first.data.subarray(excess);
        first.seq += excess;
        this.bytes -= excess;
        this.tail = first.seq;
      }
    }
  }

  /** Retained bytes from `seq` onward, flagging a gap if `seq` predates the ring. */
  replayFrom(seq: number): ReplayResult {
    const head = this.head;
    if (seq >= head) {
      return { chunks: [], gap: false, fromSeq: head, headSeq: head };
    }
    let gap = false;
    let from = seq;
    if (seq < this.tail) {
      gap = true;
      from = this.tail;
    }
    const chunks: Buffer[] = [];
    for (const c of this.chunks) {
      const end = c.seq + c.data.length;
      if (end <= from) continue; // wholly before the resume point
      chunks.push(c.seq >= from ? c.data : c.data.subarray(from - c.seq));
    }
    return { chunks, gap, fromSeq: from, headSeq: head };
  }
}
