/**
 * `/pty` WebSocket bridge (client side). Wire contract = shared
 * panel-protocol: first text frame `{t:'attached',…}`, binary frames = raw
 * PTY bytes both ways, `{t:'resize'}` upstream, `{t:'error',code}` downstream.
 * Close codes: 4403 user credential required (rw), 4404 unknown session,
 * 4410 session ended.
 */

export interface PtyConnection {
  sendInput(data: Uint8Array): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

export interface PtyHandlers {
  onAttached?: (info: {
    fromSeq: number;
    headSeq: number;
    gap: boolean;
    readOnly: boolean;
  }) => void;
  onOutput: (data: Uint8Array) => void;
  onErrorCode?: (code: string) => void;
  onClose?: (info: { code: number }) => void;
}

export function connectPty(
  sessionId: string,
  mode: 'rw' | 'ro',
  handlers: PtyHandlers,
): PtyConnection {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(
    `${proto}//${location.host}/pty?sid=${encodeURIComponent(sessionId)}&mode=${mode}`,
  );
  ws.binaryType = 'arraybuffer';

  ws.onmessage = (ev) => {
    if (ev.data instanceof ArrayBuffer) {
      handlers.onOutput(new Uint8Array(ev.data));
      return;
    }
    try {
      const msg = JSON.parse(String(ev.data)) as {
        t?: string;
        code?: string;
        fromSeq?: number;
        headSeq?: number;
        gap?: boolean;
        readOnly?: boolean;
      };
      if (msg.t === 'attached') {
        handlers.onAttached?.({
          fromSeq: msg.fromSeq ?? 0,
          headSeq: msg.headSeq ?? 0,
          gap: msg.gap ?? false,
          readOnly: msg.readOnly ?? mode === 'ro',
        });
      } else if (msg.t === 'error' && typeof msg.code === 'string') {
        handlers.onErrorCode?.(msg.code);
      }
    } catch {
      /* unknown text frame — ignore */
    }
  };
  ws.onclose = (ev) => handlers.onClose?.({ code: ev.code });

  return {
    sendInput: (data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    },
    resize: (cols, rows) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'resize', cols, rows }));
    },
    close: () => ws.close(),
  };
}
