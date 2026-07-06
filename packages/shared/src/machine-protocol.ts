/**
 * Machine registry + remote-agent wire contract (M8).
 *
 * A "machine" is a second host whose sessions appear in the fleet. The default
 * (and only v1) remote transport is an SSH **stdio relay**: the server spawns
 * `ssh <host> <remote-agent-cmd>` and speaks the exact same binary frame
 * protocol (host-protocol.ts) over the child's stdin/stdout. No new listening
 * ports are ever opened — SSH is both the pipe and the authentication.
 *
 * The remote agent (`paneld agent`, see @terminull/session-host) is a
 * frame-boundary-aware relay in front of the REMOTE machine's own paneld unix
 * socket: sessions live in the remote daemon, so a dropped SSH link never
 * kills them — the panel honestly reports the machine `stale{lastSeenAt}` and
 * reattaches (with ring replay) when the relay comes back.
 *
 * Unit tests exercise this contract with a LOCAL fake only: a spawned
 * `node <paneld bin> agent --state-dir <tmpdir>` child — never a real `ssh`.
 */
import { z } from 'zod';
import { ClientControlSchema, HostControlSchema } from './host-protocol.js';

// ---------------------------------------------------------------------------
// Machine identity + transport spec
// ---------------------------------------------------------------------------

/** The implicit machine every install has. Never listed in machines.json. */
export const LOCAL_MACHINE_ID = 'local';

/** Machine ids are short slugs: URL/file/event-payload safe, human-typeable. */
export const MACHINE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * Command the enroller installs on the remote, relative to the remote $HOME
 * (`ssh host <cmd>` runs with cwd=$HOME). The launcher script pins an absolute
 * node path resolved at enroll time — it never trusts the remote PATH.
 */
export const DEFAULT_REMOTE_AGENT_CMD = '.terminull-agent/bin/terminull-agent';

/** Spawn an arbitrary local child and speak frames over its stdio (tests!). */
export const StdioTransportSpecSchema = z
  .object({
    kind: z.literal('stdio'),
    /** Executable (resolved via PATH by child_process.spawn; no shell). */
    cmd: z.string().min(1),
    args: z.array(z.string()).default([]),
  })
  .strict();
export type StdioTransportSpec = z.infer<typeof StdioTransportSpecSchema>;

/** SSH stdio relay — sugar that compiles to a {@link StdioTransportSpec}. */
export const SshTransportSpecSchema = z
  .object({
    kind: z.literal('ssh'),
    /** SSH destination (`user@host` or an ssh_config alias). */
    host: z.string().min(1),
    /** Remote command; defaults to {@link DEFAULT_REMOTE_AGENT_CMD}. */
    remoteCmd: z.string().min(1).optional(),
    /** Extra ssh args (e.g. `-o ServerAliveInterval=5`). */
    sshArgs: z.array(z.string()).default([]),
  })
  .strict();
export type SshTransportSpec = z.infer<typeof SshTransportSpecSchema>;

/** How the server reaches a machine's agent. Discriminated on `kind`. */
export const TransportSpecSchema = z.discriminatedUnion('kind', [
  StdioTransportSpecSchema,
  SshTransportSpecSchema,
]);
export type TransportSpec = z.infer<typeof TransportSpecSchema>;

/**
 * Lower an ssh spec to the stdio spec actually spawned. `-T` (no TTY) keeps
 * the byte stream clean; `BatchMode=yes` turns a would-be password prompt into
 * an immediate honest failure instead of a silent hang.
 */
export function sshSpecToStdio(spec: SshTransportSpec): StdioTransportSpec {
  return {
    kind: 'stdio',
    cmd: 'ssh',
    args: [
      '-T',
      '-o',
      'BatchMode=yes',
      ...spec.sshArgs,
      spec.host,
      spec.remoteCmd ?? DEFAULT_REMOTE_AGENT_CMD,
    ],
  };
}

/** One machine registry entry (persisted in `<stateDir>/machines.json`). */
export const MachineConfigSchema = z
  .object({
    id: z.string().regex(MACHINE_ID_RE),
    /** Human label shown on fleet cards. */
    label: z.string().min(1).max(64),
    transport: TransportSpecSchema,
    enabled: z.boolean().default(true),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    if (cfg.id === LOCAL_MACHINE_ID) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['id'],
        message: 'machine_id_reserved',
      });
    }
  });
export type MachineConfig = z.infer<typeof MachineConfigSchema>;

/** File name inside the server state dir. */
export const MACHINES_FILE = 'machines.json';

/** Shape of `<stateDir>/machines.json`. Duplicate ids are refused, not merged. */
export const MachinesFileSchema = z
  .object({
    version: z.literal(1),
    machines: z.array(MachineConfigSchema),
  })
  .strict()
  .superRefine((file, ctx) => {
    const seen = new Set<string>();
    file.machines.forEach((m, i) => {
      if (seen.has(m.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['machines', i, 'id'],
          message: 'machine_id_duplicate',
        });
      }
      seen.add(m.id);
    });
  });
export type MachinesFile = z.infer<typeof MachinesFileSchema>;

// ---------------------------------------------------------------------------
// Connection state machine
// ---------------------------------------------------------------------------

/**
 * Per-machine connection state:
 *
 *   disabled ──(enable)──▶ connecting ──(hello ok)──▶ connected
 *   connecting ◀─(retry, never yet reached)─┘   │
 *   connected ──(relay exit / heartbeat timeout / link close)──▶ stale
 *   stale ──(redial + hello ok)──▶ connected
 *
 * Honesty rules: `stale` REQUIRES `lastSeenAt` (the last verified contact) —
 * a machine that stops responding is never shown as connected and never
 * silently dropped. A machine that has never been reached stays `connecting`
 * (with `attempts`/`lastError`), because there is no "last seen" to report.
 */
export const MACHINE_CONNECTION_STATES = ['connecting', 'connected', 'stale', 'disabled'] as const;
export type MachineConnectionState = (typeof MACHINE_CONNECTION_STATES)[number];

/** One machine's live status, as reported in fleet snapshots + /api/machines. */
export interface MachineStateDto {
  id: string;
  label: string;
  state: MachineConnectionState;
  /** Epoch ms of the last successful contact; null when never reached. */
  lastSeenAt: number | null;
  /** Remote paneld identity, known after the first successful hello. */
  hostId?: string;
  /** Remote daemon boot id; a change means its sessions died with it. */
  bootId?: string;
  /** Consecutive failed dials since the last success. */
  attempts?: number;
  /** Machine-readable code of the most recent failure. */
  lastError?: string;
}

/** Why a machine changed state (machine-readable; clients own the prose). */
export const MACHINE_STATE_CODES = [
  'boot',
  'dial_ok',
  'dial_failed',
  'relay_exit',
  'heartbeat_timeout',
  'link_closed',
  'enabled',
  'disabled',
] as const;
export type MachineStateCode = (typeof MACHINE_STATE_CODES)[number];

/** Payload of the `machine.state` guarded event (one per FSM transition). */
export interface MachineStatePayload {
  machineId: string;
  previous: MachineConnectionState;
  state: MachineConnectionState;
  lastSeenAt: number | null;
  code: MachineStateCode;
}

// ---------------------------------------------------------------------------
// Remote-collect CTRL vocabulary (relay-terminated, never reaches paneld)
// ---------------------------------------------------------------------------

/**
 * A remote-discovered session, mirroring adapter-sdk's DiscoveredSession
 * minus `transcriptRef` (remote transcript windows are NOT supported in v1 —
 * the server answers `{supported:false, reason:'remote_transcript'}` honestly).
 */
export const RemoteSessionSchema = z
  .object({
    id: z.string().min(1),
    tool: z.string().min(1),
    /** MUST be false whenever liveness cannot be verified remotely. */
    live: z.boolean(),
    cwd: z.string().optional(),
    title: z.string().optional(),
    updatedAt: z.number().int().nonnegative().optional(),
  })
  .strict();
export type RemoteSession = z.infer<typeof RemoteSessionSchema>;

/** Per-adapter collect status on the remote (mirrors AdapterFleetStatus). */
export const RemoteAdapterStatusSchema = z
  .object({
    adapterId: z.string().min(1),
    ok: z.boolean(),
    error: z.literal('collector_failed').optional(),
    sessions: z.number().int().nonnegative(),
  })
  .strict();
export type RemoteAdapterStatus = z.infer<typeof RemoteAdapterStatusSchema>;

/** client -> agent: report the machine's tool sessions (filesystem collectors). */
export const CollectSchema = z.object({ t: z.literal('collect'), reqId: z.string() }).strict();

/**
 * agent -> client: collect reply. `supported:false` (with a `reason` code such
 * as `collectors_unavailable`) is the HONEST answer of an agent built without
 * collector modules — never an empty list dressed up as "zero sessions".
 */
export const CollectedSchema = z
  .object({
    t: z.literal('collected'),
    reqId: z.string(),
    supported: z.boolean(),
    reason: z.string().optional(),
    adapters: z.array(RemoteAdapterStatusSchema),
    sessions: z.array(RemoteSessionSchema),
  })
  .strict();
export type Collected = z.infer<typeof CollectedSchema>;

/**
 * The CTRL vocabulary on an AGENT link = paneld's vocabulary + collect.
 * `collect` is terminated by the relay itself; plain paneld never sees it
 * (and would reject it — `ClientControlSchema` stays closed on purpose).
 */
export const AgentClientControlSchema = z.discriminatedUnion('t', [
  ...ClientControlSchema.options,
  CollectSchema,
]);
export type AgentClientControl = z.infer<typeof AgentClientControlSchema>;

export const AgentHostControlSchema = z.discriminatedUnion('t', [
  ...HostControlSchema.options,
  CollectedSchema,
]);
export type AgentHostControl = z.infer<typeof AgentHostControlSchema>;

// ---------------------------------------------------------------------------
// Agent stdio preamble
// ---------------------------------------------------------------------------

/**
 * First line the agent prints on stdout before any binary frame. Remote shells
 * may emit profile/MOTD noise ahead of the agent; the client discards bytes
 * until this exact line, then feeds the remainder to the frame decoder. All
 * agent diagnostics go to stderr — stdout is reserved for the preamble+frames.
 */
export const AGENT_PREAMBLE = 'TERMINULL-AGENT-1';

/** Give up scanning for the preamble after this many bytes (honest failure). */
export const AGENT_PREAMBLE_MAX_SCAN = 64 * 1024;
