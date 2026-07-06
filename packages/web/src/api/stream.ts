/**
 * WS event-stream client — lives OUTSIDE React on purpose.
 *
 * The server is the single source of truth: it streams seq-numbered envelopes
 * on `/ws` (first frame: `hello{seq}`). This module ingests them into an
 * internal buffer and flushes to subscribers at most once per animation frame
 * (a burst of events causes ONE store update, not N re-renders). Any seq gap —
 * missed frames, reconnect — triggers a REST resync via `GET /api/events?since=`;
 * if the server reports its bounded inbox no longer covers the gap, `onGap`
 * fires so snapshot-shaped stores (fleet, confirmations) refetch instead of
 * pretending the stream is complete.
 */
import type { Envelope } from '@terminull/shared';
import { api } from './client';

export type StreamStatus = 'connecting' | 'online' | 'resyncing' | 'offline';

export interface StreamHandlers {
  onStatus?: (status: StreamStatus) => void;
  /** Batched, seq-ascending envelopes (at most one call per frame). */
  onEvents?: (batch: Envelope[]) => void;
  /** The stream skipped past lost history — snapshot stores must refetch. */
  onGap?: () => void;
}

/** Minimal WebSocket surface (injectable in tests). */
export interface WebSocketLike {
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  close(): void;
}

export interface EventStreamOptions {
  url?: string;
  handlers: StreamHandlers;
  /** Test injection: WebSocket factory. */
  wsFactory?: (url: string) => WebSocketLike;
  /** Test injection: flush scheduler (defaults to rAF, setTimeout fallback). */
  schedule?: (flush: () => void) => void;
  backoffMinMs?: number;
  backoffMaxMs?: number;
}

function defaultSchedule(flush: () => void): void {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => flush());
  else setTimeout(flush, 16);
}

function defaultWsFactory(url: string): WebSocketLike {
  return new WebSocket(url) as unknown as WebSocketLike;
}

function wsUrl(path: string): string {
  if (typeof location === 'undefined') return path;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${path}`;
}

export class EventStream {
  /** Highest seq applied so far (0 = nothing seen). */
  lastSeq = 0;
  status: StreamStatus = 'offline';

  private readonly handlers: StreamHandlers;
  private readonly wsFactory: (url: string) => WebSocketLike;
  private readonly schedule: (flush: () => void) => void;
  private readonly url: string;
  private readonly backoffMinMs: number;
  private readonly backoffMaxMs: number;

  private ws: WebSocketLike | null = null;
  private buffer: Envelope[] = [];
  private flushScheduled = false;
  private stopped = true;
  private backoffMs: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private resyncing = false;

  constructor(opts: EventStreamOptions) {
    this.handlers = opts.handlers;
    this.wsFactory = opts.wsFactory ?? defaultWsFactory;
    this.schedule = opts.schedule ?? defaultSchedule;
    this.url = opts.url ?? wsUrl('/ws');
    this.backoffMinMs = opts.backoffMinMs ?? 500;
    this.backoffMaxMs = opts.backoffMaxMs ?? 8000;
    this.backoffMs = this.backoffMinMs;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
    this.setStatus('offline');
  }

  private setStatus(status: StreamStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.handlers.onStatus?.(status);
  }

  private connect(): void {
    if (this.stopped) return;
    this.setStatus('connecting');
    let ws: WebSocketLike;
    try {
      ws = this.wsFactory(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.backoffMs = this.backoffMinMs;
    };
    ws.onmessage = (ev) => {
      this.onMessage(ev.data);
    };
    ws.onclose = () => {
      if (this.ws === ws) {
        this.ws = null;
        this.setStatus('offline');
        this.scheduleReconnect();
      }
    };
    ws.onerror = () => {
      ws.close();
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.backoffMaxMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private onMessage(data: unknown): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(data));
    } catch {
      return; // not our frame — ignore, never crash the stream
    }
    const msg = parsed as { t?: string; seq?: number; event?: Envelope };
    if (msg.t === 'hello' && typeof msg.seq === 'number') {
      // Anything appended while we were away is fetched over REST.
      if (msg.seq > this.lastSeq) void this.resync(msg.seq);
      else this.setStatus('online');
      return;
    }
    if (msg.t === 'event' && msg.event) {
      const ev = msg.event;
      if (ev.seq <= this.lastSeq) return; // duplicate (resync overlap)
      if (ev.seq > this.lastSeq + 1 && !this.resyncing) {
        void this.resync(ev.seq);
        return;
      }
      this.push(ev);
    }
  }

  private push(ev: Envelope): void {
    this.lastSeq = Math.max(this.lastSeq, ev.seq);
    this.buffer.push(ev);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    this.schedule(() => {
      this.flushScheduled = false;
      const batch = this.buffer;
      this.buffer = [];
      if (batch.length > 0) this.handlers.onEvents?.(batch);
    });
  }

  /** REST catch-up to at least `targetSeq`; live frames buffered meanwhile. */
  private async resync(targetSeq: number): Promise<void> {
    if (this.resyncing) return;
    this.resyncing = true;
    this.setStatus('resyncing');
    try {
      const res = await api.eventsSince(this.lastSeq);
      if (res.gap) this.handlers.onGap?.();
      for (const ev of res.events) {
        if (ev.seq > this.lastSeq) this.push(ev);
      }
      // The server may have advanced past our fetch — accept the horizon
      // honestly; later live frames re-trigger resync if a hole remains.
      if (res.seq >= targetSeq) this.setStatus('online');
      else this.setStatus(this.ws ? 'online' : 'offline');
    } catch {
      this.setStatus(this.ws ? 'connecting' : 'offline');
    } finally {
      this.resyncing = false;
    }
  }
}
