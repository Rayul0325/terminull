/**
 * Typed REST client. Same-origin by default (dev: the Vite proxy forwards
 * /api,/ws,/pty to the panel server with the Origin header stripped, matching
 * the server's no-Origin curl allowance; prod is genuinely same-origin).
 *
 * The server returns machine codes, never prose — {@link ApiHttpError.code}
 * is what UI maps to i18n strings.
 */
import type {
  ApproveResponse,
  ConfirmationsResponse,
  DirectiveResponse,
  EventsResponse,
  FleetSnapshot,
  HealthResponse,
  SpawnResponse,
  TranscriptResponse,
} from './types';

/** A non-2xx REST response, carrying the server's machine error body. */
export class ApiHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly body: Record<string, unknown> = {},
  ) {
    super(`${status} ${code}`);
    this.name = 'ApiHttpError';
  }
}

/** Injectable for tests; browsers use the global. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

let fetchImpl: FetchLike = (input, init) => fetch(input, init);

/** Test hook: swap the fetch implementation (returns a restore function). */
export function setFetchImpl(impl: FetchLike): () => void {
  const prev = fetchImpl;
  fetchImpl = impl;
  return () => {
    fetchImpl = prev;
  };
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetchImpl(path, {
    method,
    ...(body !== undefined
      ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : {}),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!res.ok && res.status !== 202) {
    const errBody =
      parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    const code = typeof errBody['code'] === 'string' ? (errBody['code'] as string) : 'http_error';
    throw new ApiHttpError(res.status, code, errBody);
  }
  return parsed as T;
}

export const api = {
  health: () => request<HealthResponse>('GET', '/api/health'),
  fleet: () => request<FleetSnapshot>('GET', '/api/fleet'),
  eventsSince: (seq: number) => request<EventsResponse>('GET', `/api/events?since=${seq}`),
  sendDirective: (sessionId: string, text: string) =>
    request<DirectiveResponse>('POST', '/api/directive', { sessionId, text }),
  spawnSession: (body: {
    adapterId: string;
    cwd: string;
    model?: string;
    permissionMode?: string;
    cmd?: string;
    args?: string[];
    label?: string;
  }) => request<SpawnResponse>('POST', '/api/sessions', body),
  deleteSession: (sessionId: string, confirmPhrase: string) =>
    request<{ deleted: boolean; exited: boolean }>(
      'DELETE',
      `/api/sessions/${encodeURIComponent(sessionId)}`,
      { confirmPhrase },
    ),
  transcript: (sessionId: string, cursor?: number) =>
    request<TranscriptResponse>(
      'GET',
      `/api/sessions/${encodeURIComponent(sessionId)}/transcript` +
        (cursor !== undefined ? `?cursor=${cursor}` : ''),
    ),
  confirmations: () => request<ConfirmationsResponse>('GET', '/api/confirmations'),
  approveConfirmation: (id: string) =>
    request<ApproveResponse>('POST', `/api/confirmations/${encodeURIComponent(id)}/approve`),
  rejectConfirmation: (id: string) =>
    request<{ rejected: boolean }>('POST', `/api/confirmations/${encodeURIComponent(id)}/reject`),
};
