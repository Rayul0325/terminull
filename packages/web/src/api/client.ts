/**
 * Typed REST client. Same-origin by default (dev: the Vite proxy forwards
 * /api,/ws,/pty to the panel server with the Origin header stripped, matching
 * the server's no-Origin curl allowance; prod is genuinely same-origin).
 *
 * The server returns machine codes, never prose — {@link ApiHttpError.code}
 * is what UI maps to i18n strings.
 */
import type {
  AgentApprovalsResponse,
  AgentChatAccepted,
  AgentResolveResponse,
  AgentStatusDto,
  ApproveResponse,
  ConfirmationsResponse,
  CustomHarnessGroupDto,
  DirectiveResponse,
  EventsResponse,
  FleetSnapshot,
  HarnessBackupsResponse,
  HarnessFilesResponse,
  HarnessReadDto,
  HarnessRestoreRequest,
  HarnessWriteRequest,
  HarnessWriteResponse,
  HealthResponse,
  KeybindingsDto,
  MachinesResponse,
  PermissionClass,
  PermissionSettingsDto,
  ProfileCreateResponse,
  ProfileSwitchResponse,
  ProfilesDto,
  SessionStatusResponse,
  SpawnResponse,
  ToolAccountResponse,
  ToolModelsResponse,
  ToolProfileDto,
  ToolsResponse,
  TranscriptResponse,
  UsageGaugeDto,
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
  machines: () => request<MachinesResponse>('GET', '/api/machines'),
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
    /** Target machine id; omitted = 'local' (M8 contract, additive). */
    machine?: string;
    /** Account profile for the NEW spawn; omitted = the active one (M9). */
    profile?: string;
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

  // --- Manage agent (/api/agent/*, M7 contract) ---
  agentStatus: () => request<AgentStatusDto>('GET', '/api/agent/status'),
  agentChat: (text: string) => request<AgentChatAccepted>('POST', '/api/agent/chat', { text }),
  agentPermissionSettings: () =>
    request<PermissionSettingsDto>('GET', '/api/agent/permission-settings'),
  putAgentPermissionSettings: (changes: Record<string, PermissionClass>) =>
    request<PermissionSettingsDto>('PUT', '/api/agent/permission-settings', { changes }),
  agentApprovals: () => request<AgentApprovalsResponse>('GET', '/api/agent/approvals'),
  resolveAgentApproval: (id: string, decision: 'approve' | 'reject') =>
    request<AgentResolveResponse>(
      'POST',
      `/api/agent/approvals/${encodeURIComponent(id)}/resolve`,
      { decision },
    ),

  // --- Tool adapter surfaces (/api/tools/*, M7 contract) ---
  tools: () => request<ToolsResponse>('GET', '/api/tools'),
  toolUsage: (toolId: string) =>
    request<UsageGaugeDto>('GET', `/api/tools/${encodeURIComponent(toolId)}/usage`),
  toolModels: (toolId: string) =>
    request<ToolModelsResponse>('GET', `/api/tools/${encodeURIComponent(toolId)}/models`),
  toolAccount: (toolId: string) =>
    request<ToolAccountResponse>('GET', `/api/tools/${encodeURIComponent(toolId)}/account`),

  // --- Harness editor (/api/harness/*, M9 contract) ---
  harnessFiles: () => request<HarnessFilesResponse>('GET', '/api/harness/files'),
  harnessRead: (fileId: string) =>
    request<HarnessReadDto>('GET', `/api/harness/files/${encodeURIComponent(fileId)}`),
  harnessWrite: (fileId: string, body: HarnessWriteRequest) =>
    request<HarnessWriteResponse>('PUT', `/api/harness/files/${encodeURIComponent(fileId)}`, body),
  harnessBackups: (fileId: string) =>
    request<HarnessBackupsResponse>(
      'GET',
      `/api/harness/files/${encodeURIComponent(fileId)}/backups`,
    ),
  harnessRestore: (fileId: string, body: HarnessRestoreRequest) =>
    request<HarnessWriteResponse>(
      'POST',
      `/api/harness/files/${encodeURIComponent(fileId)}/restore`,
      body,
    ),
  harnessCustom: () => request<CustomHarnessGroupDto>('GET', '/api/harness/custom'),

  // --- Account profiles (/api/profiles, M9 contract) ---
  profiles: () => request<ProfilesDto>('GET', '/api/profiles'),
  createProfile: (body: ToolProfileDto) =>
    request<ProfileCreateResponse>('POST', '/api/profiles', body),
  deleteProfile: (toolId: string, profileId: string) =>
    request<{ deleted: true }>(
      'DELETE',
      `/api/profiles/${encodeURIComponent(toolId)}/${encodeURIComponent(profileId)}`,
    ),
  switchProfile: (toolId: string, profileId: string) =>
    request<ProfileSwitchResponse>('POST', '/api/profiles/switch', { toolId, profileId }),

  // --- Session statusbar seed (M9 contract; :sid = TOOL-NATIVE session id) ---
  sessionStatus: (sid: string) =>
    request<SessionStatusResponse>('GET', `/api/sessions/${encodeURIComponent(sid)}/status`),

  // --- Roaming keybinding prefs (M9 contract; PUT = full replace, user-only) ---
  keybindings: () => request<KeybindingsDto>('GET', '/api/prefs/keybindings'),
  putKeybindings: (dto: KeybindingsDto) =>
    request<KeybindingsDto>('PUT', '/api/prefs/keybindings', dto),
};
