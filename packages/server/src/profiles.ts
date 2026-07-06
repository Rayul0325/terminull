/**
 * Account-profile registry (M9 D1) — `<stateDir>/profiles.json`, server-owned.
 *
 * A profile is ONLY a pointer `{id, toolId, label, configHome}` at an isolated
 * config home. This module never reads a configHome's contents, never touches
 * credentials, and never stores the implicit `default` profile (the real
 * home). The legacy adapter-side registries (`<home>/.terminull/profiles/…`)
 * stay read-only display remnants — this file is the single canonical source
 * for `/api/profiles`.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_PROFILE_ID,
  PROFILES_FILE,
  ProfilesFileSchema,
  type ProfilesDto,
  type ProfilesFile,
  type ToolProfileDto,
} from '@terminull/shared';

/** Thrown when profiles.json exists but fails validation (boot/runtime 500). */
export class ProfilesFileInvalidError extends Error {
  readonly code = 'profiles_file_invalid';
  constructor(detail: string) {
    super(`invalid ${PROFILES_FILE}: ${detail}`);
    this.name = 'ProfilesFileInvalidError';
  }
}

const emptyFile = (): ProfilesFile => ({ version: 1, profiles: [], active: {} });

/**
 * Read `<stateDir>/profiles.json`. Absent file = empty registry (a valid,
 * common state). A corrupt/invalid file throws — a half-read profile registry
 * must never boot silently (mirrors machines.json semantics).
 */
export function loadProfilesFile(stateDir: string): ProfilesFile {
  const file = path.join(stateDir, PROFILES_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return emptyFile();
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (e) {
    throw new ProfilesFileInvalidError(e instanceof Error ? e.message : 'parse_error');
  }
  const parsed = ProfilesFileSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new ProfilesFileInvalidError(parsed.error.issues[0]?.message ?? 'invalid_shape');
  }
  return parsed.data;
}

/** Atomically write `<stateDir>/profiles.json` (write-then-rename, 0600). */
export function saveProfilesFile(stateDir: string, file: ProfilesFile): void {
  const target = path.join(stateDir, PROFILES_FILE);
  const body = JSON.stringify(file, null, 2) + '\n';
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, target);
}

/**
 * In-memory registry over the canonical file. Every mutation validates, saves
 * write-then-rename, and only then commits to memory — a failed save never
 * leaves memory and disk split-brained.
 */
export class ProfilesRegistry {
  private file: ProfilesFile;

  constructor(private readonly stateDir: string) {
    // Boot honesty: a corrupt profiles.json throws here, never boots silently.
    this.file = loadProfilesFile(stateDir);
  }

  /** The wire DTO for `GET /api/profiles`. */
  snapshot(): ProfilesDto {
    return {
      version: 1,
      profiles: this.file.profiles.map((p) => ({ ...p })),
      active: { ...this.file.active },
    };
  }

  find(toolId: string, profileId: string): ToolProfileDto | undefined {
    return this.file.profiles.find((p) => p.toolId === toolId && p.id === profileId);
  }

  /** The active profile id for a tool (`default` when none is set). */
  activeOf(toolId: string): string {
    return this.file.active[toolId] ?? DEFAULT_PROFILE_ID;
  }

  /** True when the (tool, id) pair already exists. */
  has(toolId: string, profileId: string): boolean {
    return this.find(toolId, profileId) !== undefined;
  }

  /** Add a profile (caller pre-checks reserved id + duplicates). */
  create(profile: ToolProfileDto): void {
    const next: ProfilesFile = {
      ...this.file,
      profiles: [...this.file.profiles, { ...profile }],
    };
    this.commit(next);
  }

  /**
   * Delete a registry ENTRY only — the configHome's contents are never
   * touched. An active pointer at the deleted profile falls back to default.
   */
  delete(toolId: string, profileId: string): boolean {
    if (!this.has(toolId, profileId)) return false;
    const active = { ...this.file.active };
    if (active[toolId] === profileId) delete active[toolId];
    const next: ProfilesFile = {
      ...this.file,
      profiles: this.file.profiles.filter((p) => !(p.toolId === toolId && p.id === profileId)),
      active,
    };
    this.commit(next);
    return true;
  }

  /** Point `active[toolId]` at a profile (`default` deletes the entry). */
  setActive(toolId: string, profileId: string): void {
    const active = { ...this.file.active };
    if (profileId === DEFAULT_PROFILE_ID) delete active[toolId];
    else active[toolId] = profileId;
    this.commit({ ...this.file, active });
  }

  /** Validate → save → commit to memory (in that order, never partially). */
  private commit(next: ProfilesFile): void {
    const parsed = ProfilesFileSchema.safeParse(next);
    if (!parsed.success) {
      throw new ProfilesFileInvalidError(parsed.error.issues[0]?.message ?? 'invalid_shape');
    }
    saveProfilesFile(this.stateDir, parsed.data);
    this.file = parsed.data;
  }
}
