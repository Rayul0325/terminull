/**
 * Account-profile registry wire contract (M9) — isolated config-home profiles
 * per tool, server-owned, switchable for NEW spawns only.
 *
 * Security invariants (violations are contract bugs):
 *  - A profile is ONLY a pointer: `{id, toolId, label, configHome}`. The server
 *    NEVER copies/moves/bridges/proxies credentials between homes, never reads
 *    credential bodies, and never logs a home's contents.
 *  - Switching changes which env vars future spawns receive (the adapter's
 *    `configHomeEnvVars`, e.g. `CLAUDE_CONFIG_DIR` / `CODEX_HOME`). Live
 *    sessions are untouched — the switch response carries `liveSessionCount`
 *    so the client can render an honest "N개 세션은 기존 계정 유지" warning;
 *    a restart is never performed on the user's behalf.
 *  - `default` is the implicit real-home profile: it is never stored in the
 *    registry file and never gets env overrides.
 */
import { z } from 'zod';

/** The implicit real-home profile id (reserved; refused in the registry). */
export const DEFAULT_PROFILE_ID = 'default';

/** Profile-id slug rule (mirrors MACHINE_ID_RE's shape). */
export const PROFILE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** The profiles registry file name under the server state dir. */
export const PROFILES_FILE = 'profiles.json';

/**
 * True for an absolute POSIX (`/…`) or Windows (`C:\…`) path. Implemented
 * without node:path — this module is imported by the web bundle.
 */
export function isAbsolutePathname(p: string): boolean {
  return /^\//.test(p) || /^[A-Za-z]:[\\/]/.test(p);
}

/** One registry profile: a labelled pointer at an isolated config home. */
export const ToolProfileDtoSchema = z
  .object({
    id: z.string().regex(PROFILE_ID_RE),
    toolId: z.string().min(1),
    label: z.string().min(1).max(60),
    /** ABSOLUTE path of the isolated config home. Never a credential store. */
    configHome: z.string().min(1).refine(isAbsolutePathname, {
      message: 'configHome must be an absolute path',
    }),
  })
  .strict();
export type ToolProfileDto = z.infer<typeof ToolProfileDtoSchema>;

/**
 * `<stateDir>/profiles.json` — the server-owned registry. `active` maps
 * toolId → profileId; a missing entry means `default`. Every non-default
 * active id must exist in `profiles` (validated here, not at use time).
 */
export const ProfilesFileSchema = z
  .object({
    version: z.literal(1),
    profiles: z.array(ToolProfileDtoSchema),
    active: z.record(z.string().min(1), z.string().min(1)),
  })
  .strict()
  .superRefine((file, ctx) => {
    const seen = new Set<string>();
    for (const [i, p] of file.profiles.entries()) {
      if (p.id === DEFAULT_PROFILE_ID) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'profile_id_reserved',
          path: ['profiles', i, 'id'],
        });
      }
      const key = `${p.toolId}:${p.id}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'profile_id_duplicate',
          path: ['profiles', i, 'id'],
        });
      }
      seen.add(key);
    }
    for (const [toolId, profileId] of Object.entries(file.active)) {
      if (profileId === DEFAULT_PROFILE_ID) continue;
      if (!seen.has(`${toolId}:${profileId}`)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'active_profile_unknown',
          path: ['active', toolId],
        });
      }
    }
  });
export type ProfilesFile = z.infer<typeof ProfilesFileSchema>;

/** Body of `POST /api/profiles` (create; user-actor only). */
export const ProfileCreateRequestSchema = ToolProfileDtoSchema.refine(
  (p) => p.id !== DEFAULT_PROFILE_ID,
  { message: 'profile_id_reserved' },
);
export type ProfileCreateRequest = z.infer<typeof ProfileCreateRequestSchema>;

/** Body of `POST /api/profiles/switch` (gated by the `account.switch` action). */
export const ProfileSwitchRequestSchema = z
  .object({
    toolId: z.string().min(1),
    /** Target profile — `'default'` switches back to the real home. */
    profileId: z.string().min(1),
  })
  .strict();
export type ProfileSwitchRequest = z.infer<typeof ProfileSwitchRequestSchema>;

/**
 * Response of a successful switch. `liveSessionCount` = sessions of this tool
 * currently RUNNING (they keep their old account until the user restarts them
 * — the client must render this warning, the server never restarts anything).
 */
export interface ProfileSwitchResponse {
  switched: true;
  toolId: string;
  profileId: string;
  liveSessionCount: number;
}

/** Response of `GET /api/profiles`. `active` omits tools on `default`. */
export interface ProfilesDto {
  version: 1;
  profiles: ToolProfileDto[];
  active: Record<string, string>;
}

/**
 * Stable machine error codes for the profile routes:
 *  - `unknown_profile` 400 — profileId not in the registry (and not default);
 *  - `profile_id_reserved` 400 — attempt to create/delete `default`;
 *  - `profile_id_duplicate` 409 — create collides with an existing (tool,id);
 *  - `profile_unsupported` 422 — the tool has no `configHomeEnvVars`;
 *  - `profile_machine_unsupported` 422 — non-default profile on a remote
 *    machine spawn (configHome paths are local-machine only in v1);
 *  - `profiles_file_invalid` 500 — registry on disk failed validation.
 */
export const PROFILE_ERROR_CODES = [
  'unknown_profile',
  'profile_id_reserved',
  'profile_id_duplicate',
  'profile_unsupported',
  'profile_machine_unsupported',
  'profiles_file_invalid',
] as const;
export type ProfileErrorCode = (typeof PROFILE_ERROR_CODES)[number];
