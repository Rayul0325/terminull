/**
 * connectPty URL tests (M9 W6 oracle — the rw entry point must dial
 * `/pty?...mode=rw`; the read-only default stays `mode=ro`). WebSocket and
 * location are stubbed — no server, no real terminal.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectPty } from './connectPty';

class FakeWebSocket {
  static urls: string[] = [];
  binaryType = 'blob';
  onmessage: unknown = null;
  onclose: unknown = null;
  readyState = 0;
  constructor(url: string) {
    FakeWebSocket.urls.push(url);
  }
  send(): void {}
  close(): void {}
}

afterEach(() => {
  FakeWebSocket.urls = [];
  vi.unstubAllGlobals();
});

function stubEnv(): void {
  vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
  vi.stubGlobal('location', { protocol: 'http:', host: '127.0.0.1:7420' });
}

describe('connectPty dial URL', () => {
  it('the rw entry dials mode=rw with the session id', () => {
    stubEnv();
    connectPty('sess 1', 'rw', { onOutput: () => {} });
    expect(FakeWebSocket.urls).toEqual(['ws://127.0.0.1:7420/pty?sid=sess%201&mode=rw']);
  });

  it('the default read-only path dials mode=ro', () => {
    stubEnv();
    connectPty('s-2', 'ro', { onOutput: () => {} });
    expect(FakeWebSocket.urls).toEqual(['ws://127.0.0.1:7420/pty?sid=s-2&mode=ro']);
  });
});
