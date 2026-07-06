/**
 * REST/WS payload types for the panel server.
 *
 * Runtime imports come ONLY from `@terminull/shared` (the wire contract).
 * `@terminull/server` and `@terminull/adapter-sdk` are imported TYPE-ONLY —
 * erased at build time, so no backend code ever enters the browser bundle;
 * they exist to keep response shapes single-sourced with the server.
 */
import type {
  AccountProfile,
  AccountResult,
  ChatItem,
  ModelInfo,
  ToolCapabilities,
  WhoamiInfo,
} from '@terminull/adapter-sdk';
import type {
  AdapterFleetStatus,
  FleetSession,
  FleetSnapshot,
  GateResult,
  PendingConfirmation,
} from '@terminull/server';
import type {
  AgentChatAccepted,
  AgentStatusDto,
  CustomHarnessGroupDto,
  CustomHarnessItemDto,
  Envelope,
  HarnessBackupDto,
  HarnessFileDto,
  HarnessGroupDto,
  HarnessReadDto,
  HarnessRestoreRequest,
  HarnessWriteRequest,
  HarnessWriteResponse,
  KeybindingsDto,
  LocalizedText,
  MachineConnectionState,
  MachineStateDto,
  MachineStatePayload,
  PendingApprovalCard,
  PermissionClass,
  PermissionSettingsDto,
  ProfileSwitchResponse,
  ProfilesDto,
  SessionStatusDto,
  ToolProfileDto,
  UsageGaugeDto,
} from '@terminull/shared';

export type {
  AdapterFleetStatus,
  AgentChatAccepted,
  AgentStatusDto,
  ChatItem,
  CustomHarnessGroupDto,
  CustomHarnessItemDto,
  Envelope,
  FleetSession,
  FleetSnapshot,
  HarnessBackupDto,
  HarnessFileDto,
  HarnessGroupDto,
  HarnessReadDto,
  HarnessRestoreRequest,
  HarnessWriteRequest,
  HarnessWriteResponse,
  KeybindingsDto,
  MachineConnectionState,
  MachineStateDto,
  MachineStatePayload,
  ModelInfo,
  PendingApprovalCard,
  PermissionClass,
  PermissionSettingsDto,
  ProfileSwitchResponse,
  ProfilesDto,
  SessionStatusDto,
  ToolProfileDto,
  UsageGaugeDto,
};

/** `GET /api/health` */
export interface HealthResponse {
  ok: boolean;
  version: string;
  seq: number;
  sessions: { count: number; known: boolean };
  host: { connected: boolean };
  uptime: number;
}

/** `GET /api/machines` — registered machines plus the implicit 'local' mirror. */
export interface MachinesResponse {
  machines: MachineStateDto[];
}

/** `GET /api/events?since=` */
export interface EventsResponse {
  events: Envelope[];
  seq: number;
  /** True when events older than the server's in-memory window were lost. */
  gap: boolean;
}

/** `POST /api/directive` (200 delivered / 202 queued or pending confirmation) */
export interface DirectiveResponse {
  delivered?: boolean;
  queued?: boolean;
  directiveId?: string;
  /** Present when the permission gate parked the action for user approval. */
  code?: string;
  confirmationId?: string;
}

/** `POST /api/sessions` (201) */
export interface SpawnResponse {
  sessionId: string;
  sid: number;
  pid: number;
  label: string;
}

/** `GET /api/sessions/:sid/transcript` */
export type TranscriptResponse =
  | { supported: false; reason: string }
  | {
      supported: true;
      items: ChatItem[];
      cursor: { offset: number };
      done: boolean;
      truncatedHead?: boolean;
      droppedOlder?: boolean;
      reset?: boolean;
    };

/** `GET /api/confirmations` */
export interface ConfirmationsResponse {
  pending: Array<Omit<PendingConfirmation, 'execute'>>;
}

/** `POST /api/confirmations/:id/approve` */
export interface ApproveResponse {
  approved: boolean;
  confirmationId: string;
  action: string;
  resultStatus: GateResult['status'];
  result: unknown;
}

/** `GET /api/agent/approvals` — confirmation queue filtered to agent origin. */
export interface AgentApprovalsResponse {
  pending: PendingApprovalCard[];
}

/**
 * `POST /api/agent/approvals/:id/resolve` — delegates to the same code path
 * as `/api/confirmations/:id/approve|reject`, so the body mirrors those.
 */
export type AgentResolveResponse = ApproveResponse | { rejected: boolean };

/** One `GET /api/tools` entry — DECLARED capabilities only (no probe). */
export interface ToolListEntry {
  id: string;
  displayName: LocalizedText;
  capabilities: ToolCapabilities;
}

/** `GET /api/tools` */
export interface ToolsResponse {
  tools: ToolListEntry[];
}

/** `GET /api/tools/:toolId/models` — the dynamic model registry passthrough. */
export interface ToolModelsResponse {
  models: ModelInfo[];
}

/** `GET /api/tools/:toolId/account` — whoami/profiles passthrough, honest
 * `{available:false, reason}` when the adapter cannot read them. */
export interface ToolAccountResponse {
  whoami: AccountResult<WhoamiInfo>;
  profiles: AccountResult<AccountProfile[]>;
}

// --- M9 contract surfaces (harness editor, profiles, statusbar, prefs) ---

/** `GET /api/harness/files` */
export interface HarnessFilesResponse {
  groups: HarnessGroupDto[];
}

/** `GET /api/harness/files/:fileId/backups` (newest first). */
export interface HarnessBackupsResponse {
  backups: HarnessBackupDto[];
}

/** `POST /api/profiles` (201). */
export interface ProfileCreateResponse {
  created: true;
  profile: ToolProfileDto;
}

/** `GET /api/sessions/:sid/status` — null = honest "no statusline data". */
export interface SessionStatusResponse {
  status: SessionStatusDto | null;
}
