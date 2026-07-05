/**
 * Wire protocol for paneld — the session-host daemon.
 *
 * A tiny, parser-free binary framing that any reliable byte stream (unix
 * socket, TCP, TLS) can carry. It is deliberately kept in `@terminull/shared`
 * so the future panel-server imports the exact same contract the daemon speaks.
 *
 * Frame layout (all integers little-endian):
 *
 *     frame := u32 bodyLen | u8 kind | body
 *
 *     kind 0x01 CTRL : body = UTF-8 JSON (a zod-validated discriminated union)
 *     kind 0x02 OUT  : body = u32 sid | u64 seq | raw pty bytes   (host -> client)
 *     kind 0x03 IN   : body = u32 sid | raw bytes                 (client -> host)
 *
 * `bodyLen` counts only `body` (not the 5-byte header). `seq` is a monotonic
 * byte offset into a session's output (see the session-host ring buffer); it is
 * a u64 on the wire (BigInt) but travels as a plain JSON number inside CTRL
 * messages, which is safe up to 2^53 bytes (~9 PB) of session output.
 */
import { z } from 'zod';

/** Current wire-protocol major version. Bumped on any breaking frame change. */
export const HOST_PROTO_VERSION = 1;

/** Frame kind byte. */
export const FrameKind = {
  Ctrl: 0x01,
  Out: 0x02,
  In: 0x03,
} as const;
export type FrameKind = (typeof FrameKind)[keyof typeof FrameKind];

/** Header size in bytes: u32 bodyLen + u8 kind. */
export const FRAME_HEADER_BYTES = 5;

/**
 * Hard cap on a single frame body (64 MiB). A decoder that reads a larger
 * declared length treats the stream as corrupt/hostile rather than allocating.
 */
export const DEFAULT_MAX_FRAME_BODY = 64 * 1024 * 1024;

// ---------------------------------------------------------------------------
// CTRL message schemas (zod)
// ---------------------------------------------------------------------------

/** How to launch a PTY-backed session. */
export const SpawnSpecSchema = z
  .object({
    /** Executable to run (resolved via PATH by node-pty). */
    cmd: z.string().min(1),
    /** Argument vector (no implicit shell). */
    args: z.array(z.string()).default([]),
    /** Working directory for the child. */
    cwd: z.string().min(1),
    /** Extra env layered on top of the daemon's own `process.env`. */
    env: z.record(z.string()).default({}),
    /** Initial terminal width in columns. */
    cols: z.number().int().positive(),
    /** Initial terminal height in rows. */
    rows: z.number().int().positive(),
    /** Human label for UIs (optional). */
    label: z.string().optional(),
    /** Opaque caller metadata echoed back in session summaries. */
    meta: z.record(z.unknown()).optional(),
  })
  .strict();
export type SpawnSpec = z.infer<typeof SpawnSpecSchema>;

/** One session's public state, as reported in `helloOk`/`sessions`. */
export const SessionSummarySchema = z
  .object({
    sid: z.number().int().nonnegative(),
    label: z.string().optional(),
    cmd: z.string(),
    args: z.array(z.string()),
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
    /** OS pid of the PTY leader, when known. */
    pid: z.number().int().optional(),
    /** False for sessions adopted from an external tmux server. */
    owned: z.boolean(),
    /** True while the PTY is still alive. */
    running: z.boolean(),
    /** Newest byte-seq available for replay (ring head). */
    headSeq: z.number().int().nonnegative(),
    meta: z.record(z.unknown()).optional(),
  })
  .strict();
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

// --- client -> host ---

export const HelloSchema = z
  .object({ t: z.literal('hello'), proto: z.literal(1), token: z.string() })
  .strict();
export const SpawnSchema = z
  .object({ t: z.literal('spawn'), reqId: z.string(), spec: SpawnSpecSchema })
  .strict();
export const AttachSchema = z
  .object({
    t: z.literal('attach'),
    reqId: z.string(),
    sid: z.number().int().nonnegative(),
    /** Resume output from this byte-seq (default 0 = from ring start). */
    sinceSeq: z.number().int().nonnegative().optional(),
    /** View-only: IN and resize from this attachment are rejected. */
    readOnly: z.boolean().optional(),
  })
  .strict();
export const DetachSchema = z
  .object({ t: z.literal('detach'), sid: z.number().int().nonnegative() })
  .strict();
export const ResizeSchema = z
  .object({
    t: z.literal('resize'),
    sid: z.number().int().nonnegative(),
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
  })
  .strict();
export const KillSchema = z
  .object({
    t: z.literal('kill'),
    sid: z.number().int().nonnegative(),
    /** Signal name (e.g. "SIGTERM"). Defaults to SIGTERM host-side. */
    signal: z.string().optional(),
  })
  .strict();
export const ListSchema = z.object({ t: z.literal('list'), reqId: z.string() }).strict();
export const AdoptTmuxSchema = z
  .object({ t: z.literal('adoptTmux'), reqId: z.string(), target: z.string().min(1) })
  .strict();

/** Every CTRL message a client may send to the host. */
export const ClientControlSchema = z.discriminatedUnion('t', [
  HelloSchema,
  SpawnSchema,
  AttachSchema,
  DetachSchema,
  ResizeSchema,
  KillSchema,
  ListSchema,
  AdoptTmuxSchema,
]);
export type ClientControl = z.infer<typeof ClientControlSchema>;

// --- host -> client ---

export const HelloOkSchema = z
  .object({
    t: z.literal('helloOk'),
    proto: z.literal(1),
    /** Stable per-machine id (persisted). */
    hostId: z.string(),
    /** Random per-process id; changes on every daemon restart. */
    bootId: z.string(),
    sessions: z.array(SessionSummarySchema),
  })
  .strict();
export const SpawnedSchema = z
  .object({
    t: z.literal('spawned'),
    reqId: z.string(),
    sid: z.number().int().nonnegative(),
    pid: z.number().int(),
  })
  .strict();
export const AttachedSchema = z
  .object({
    t: z.literal('attached'),
    reqId: z.string(),
    sid: z.number().int().nonnegative(),
    /** Byte-seq of the first replayed byte (== sinceSeq unless a gap forced it forward). */
    fromSeq: z.number().int().nonnegative(),
    /** Ring head at attach time; live output continues from here. */
    headSeq: z.number().int().nonnegative(),
    /** True when requested sinceSeq was older than the ring could replay. */
    gap: z.boolean(),
  })
  .strict();
export const ExitSchema = z
  .object({
    t: z.literal('exit'),
    sid: z.number().int().nonnegative(),
    code: z.number().int().nullable(),
    signal: z.number().int().nullable().optional(),
  })
  .strict();
export const SessionsSchema = z
  .object({ t: z.literal('sessions'), reqId: z.string(), sessions: z.array(SessionSummarySchema) })
  .strict();
export const HostErrorSchema = z
  .object({
    t: z.literal('error'),
    reqId: z.string().optional(),
    sid: z.number().int().nonnegative().optional(),
    code: z.string(),
    msg: z.string(),
  })
  .strict();

/** Every CTRL message the host may send to a client. */
export const HostControlSchema = z.discriminatedUnion('t', [
  HelloOkSchema,
  SpawnedSchema,
  AttachedSchema,
  ExitSchema,
  SessionsSchema,
  HostErrorSchema,
]);
export type HostControl = z.infer<typeof HostControlSchema>;

// ---------------------------------------------------------------------------
// Frame codec
// ---------------------------------------------------------------------------

/** A decoded frame, tagged by kind. CTRL bodies stay unparsed-by-schema. */
export type DecodedFrame =
  | { kind: 'ctrl'; json: unknown }
  | { kind: 'out'; sid: number; seq: bigint; data: Buffer }
  | { kind: 'in'; sid: number; data: Buffer };

/** Thrown when a byte stream cannot be framed (corrupt or hostile input). */
export class FrameError extends Error {
  readonly code = 'FRAME';
  constructor(message: string) {
    super(message);
    this.name = 'FrameError';
  }
}

function withHeader(kind: FrameKind, body: Buffer): Buffer {
  const out = Buffer.allocUnsafe(FRAME_HEADER_BYTES + body.length);
  out.writeUInt32LE(body.length, 0);
  out.writeUInt8(kind, 4);
  body.copy(out, FRAME_HEADER_BYTES);
  return out;
}

/**
 * Stateless frame encoder. Each method returns a single ready-to-write frame.
 * CTRL messages are serialised as UTF-8 JSON; callers are expected to pass an
 * already-valid {@link ClientControl}/{@link HostControl}.
 */
export const FrameEncoder = {
  ctrl(msg: ClientControl | HostControl): Buffer {
    return withHeader(FrameKind.Ctrl, Buffer.from(JSON.stringify(msg), 'utf8'));
  },
  out(sid: number, seq: bigint, data: Buffer): Buffer {
    const body = Buffer.allocUnsafe(12 + data.length);
    body.writeUInt32LE(sid, 0);
    body.writeBigUInt64LE(seq, 4);
    data.copy(body, 12);
    return withHeader(FrameKind.Out, body);
  },
  input(sid: number, data: Buffer): Buffer {
    const body = Buffer.allocUnsafe(4 + data.length);
    body.writeUInt32LE(sid, 0);
    data.copy(body, 4);
    return withHeader(FrameKind.In, body);
  },
} as const;

function decodeBody(kind: number, body: Buffer): DecodedFrame {
  switch (kind) {
    case FrameKind.Ctrl:
      return { kind: 'ctrl', json: JSON.parse(body.toString('utf8')) };
    case FrameKind.Out: {
      if (body.length < 12) throw new FrameError('OUT frame body shorter than 12-byte header');
      return {
        kind: 'out',
        sid: body.readUInt32LE(0),
        seq: body.readBigUInt64LE(4),
        data: Buffer.from(body.subarray(12)),
      };
    }
    case FrameKind.In: {
      if (body.length < 4) throw new FrameError('IN frame body shorter than 4-byte header');
      return {
        kind: 'in',
        sid: body.readUInt32LE(0),
        data: Buffer.from(body.subarray(4)),
      };
    }
    default:
      throw new FrameError(`unknown frame kind 0x${kind.toString(16)}`);
  }
}

/**
 * Stream-safe frame decoder. Feed it arbitrary chunks (partial frames or
 * several frames coalesced into one chunk are both fine) and it returns every
 * complete frame it can extract, buffering any trailing partial for next time.
 */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);
  private readonly maxBody: number;

  constructor(opts?: { maxBodyLen?: number }) {
    this.maxBody = opts?.maxBodyLen ?? DEFAULT_MAX_FRAME_BODY;
  }

  push(chunk: Buffer): DecodedFrame[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const frames: DecodedFrame[] = [];
    let off = 0;
    while (this.buf.length - off >= FRAME_HEADER_BYTES) {
      const bodyLen = this.buf.readUInt32LE(off);
      if (bodyLen > this.maxBody) {
        throw new FrameError(`frame body length ${bodyLen} exceeds max ${this.maxBody}`);
      }
      const total = FRAME_HEADER_BYTES + bodyLen;
      if (this.buf.length - off < total) break; // wait for the rest of this frame
      const kind = this.buf.readUInt8(off + 4);
      const body = this.buf.subarray(off + FRAME_HEADER_BYTES, off + total);
      frames.push(decodeBody(kind, body));
      off += total;
    }
    // Retain only the unconsumed tail. Copy it so the large concat buffer can be
    // released and returned OUT/IN data (subarrays of it) keep their own copies.
    this.buf = off === 0 ? this.buf : Buffer.from(this.buf.subarray(off));
    return frames;
  }
}
