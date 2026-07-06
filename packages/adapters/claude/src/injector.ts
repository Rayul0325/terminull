/**
 * Claude Code harness injector.
 *
 * Installs Terminull's hook set into a Claude Code home:
 *  1. copies `harness/*.sh` (the 7 event hooks + the shared lib) into
 *     `<claudeHome>/terminull/hooks/`, and
 *  2. merges hook entries into `<claudeHome>/settings.json` — parse → append the
 *     missing entries (deduped by command path) → atomic write, after backing
 *     the original up to `settings.json.terminull.bak-<ts>`.
 *
 * `plan()` describes what an install would change without touching disk.
 * `verify()` checks the markers (and can fire a synthetic panel probe, skipped
 * in tests). `uninstall()` removes exactly our entries: when the user made NO
 * edits since install it restores the original settings.json BYTE-IDENTICALLY
 * from the backup; otherwise it structurally removes our entries and leaves
 * every foreign hook intact.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HarnessContext, HarnessInjector, HarnessStatus } from '@terminull/adapter-sdk';

/** One hook the injector registers: the script file, its event, optional matcher. */
export interface HookSpec {
  file: string;
  event: string;
  matcher?: string;
}

/** The 7 registered hooks. `terminull-lib.sh` is copied too but not registered. */
export const HOOK_SPECS: readonly HookSpec[] = [
  { file: 'terminull-session-start.sh', event: 'SessionStart' },
  { file: 'terminull-activity.sh', event: 'UserPromptSubmit' },
  { file: 'terminull-ask.sh', event: 'PreToolUse', matcher: 'AskUserQuestion' },
  { file: 'terminull-plan.sh', event: 'PostToolUse', matcher: 'ExitPlanMode' },
  { file: 'terminull-notify.sh', event: 'Notification' },
  { file: 'terminull-stop.sh', event: 'Stop' },
  { file: 'terminull-session-end.sh', event: 'SessionEnd' },
];

interface HookEntry {
  type: string;
  command: string;
  [k: string]: unknown;
}
interface HookGroup {
  matcher?: string;
  hooks?: HookEntry[];
  [k: string]: unknown;
}
type Settings = Record<string, unknown> & { hooks?: Record<string, HookGroup[]> };

/** The diff `plan()` returns — machine-checkable arrays plus Korean prose. */
export interface HarnessPlan {
  /** Hook scripts that would be (re)copied. */
  willCopy: string[];
  /** settings.json entries that would be added (already-present ones omitted). */
  willAddHooks: { event: string; matcher?: string }[];
  /** Human-readable Korean summary for the panel. */
  text: string;
}

/** Options for {@link ClaudeHarnessInjector}. */
export interface ClaudeHarnessInjectorOptions {
  /** Override the `.claude` home (defaults to `<ctx.home ?? homedir>/.claude`). */
  claudeHome?: string;
  /** Override the source `harness/` dir (defaults to this package's). */
  harnessDir?: string;
  /** Optional panel liveness probe for `verify()`; omitted in tests (no network). */
  probePanel?: (ctx: HarnessContext) => Promise<boolean>;
}

const DEFAULT_HARNESS_DIR = fileURLToPath(new URL('../harness/', import.meta.url));

function isOurCommand(cmd: unknown, hooksDir: string): boolean {
  return typeof cmd === 'string' && cmd.startsWith(hooksDir + path.sep);
}

/** Serialise settings deterministically (2-space + trailing newline). */
function serialize(settings: Settings): string {
  return JSON.stringify(settings, null, 2) + '\n';
}

/** Merge our hook entries into a settings object (pure; returns a fresh clone). */
function mergeHooks(settings: Settings, hooksDir: string): Settings {
  const out = JSON.parse(JSON.stringify(settings)) as Settings;
  const hooks: Record<string, HookGroup[]> = out.hooks ?? {};
  for (const spec of HOOK_SPECS) {
    const command = path.join(hooksDir, spec.file);
    const arr = hooks[spec.event] ?? [];
    const present = arr.some(
      (g) => Array.isArray(g.hooks) && g.hooks.some((h) => h.command === command),
    );
    if (!present) {
      arr.push({
        ...(spec.matcher ? { matcher: spec.matcher } : {}),
        hooks: [{ type: 'command', command }],
      });
    }
    hooks[spec.event] = arr;
  }
  out.hooks = hooks;
  return out;
}

/** Remove exactly our hook entries from a settings object (pure). */
function stripOurHooks(settings: Settings, hooksDir: string): Settings {
  const out = JSON.parse(JSON.stringify(settings)) as Settings;
  const hooks = out.hooks;
  if (!hooks) return out;
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event] ?? [];
    const kept: HookGroup[] = [];
    for (const g of groups) {
      const entries = Array.isArray(g.hooks) ? g.hooks : [];
      const foreign = entries.filter((h) => !isOurCommand(h.command, hooksDir));
      if (foreign.length === 0) continue; // group was entirely ours → drop it
      kept.push({ ...g, hooks: foreign });
    }
    if (kept.length === 0) delete hooks[event];
    else hooks[event] = kept;
  }
  if (Object.keys(hooks).length === 0) delete out.hooks;
  return out;
}

async function atomicWrite(file: string, bytes: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, bytes);
  await fsp.rename(tmp, file);
}

/** Newest `settings.json.terminull.bak-*` for the given settings path, if any. */
async function latestBackup(settingsPath: string): Promise<string | null> {
  const dir = path.dirname(settingsPath);
  const base = path.basename(settingsPath) + '.terminull.bak-';
  let files: string[];
  try {
    files = await fsp.readdir(dir);
  } catch {
    return null;
  }
  const backups = files.filter((f) => f.startsWith(base)).sort();
  const last = backups[backups.length - 1];
  return last ? path.join(dir, last) : null;
}

/** Installs/removes/verifies Terminull's hook harness in a Claude Code home. */
export class ClaudeHarnessInjector implements HarnessInjector {
  constructor(private readonly opts: ClaudeHarnessInjectorOptions = {}) {}

  private claudeHome(ctx: HarnessContext): string {
    return this.opts.claudeHome ?? path.join(ctx.home ?? os.homedir(), '.claude');
  }
  private hooksDir(ctx: HarnessContext): string {
    return path.join(this.claudeHome(ctx), 'terminull', 'hooks');
  }
  private settingsPath(ctx: HarnessContext): string {
    return path.join(this.claudeHome(ctx), 'settings.json');
  }
  private harnessDir(): string {
    return this.opts.harnessDir ?? DEFAULT_HARNESS_DIR;
  }

  private async readSettings(
    ctx: HarnessContext,
  ): Promise<{ bytes: string | null; obj: Settings }> {
    try {
      const bytes = await fsp.readFile(this.settingsPath(ctx), 'utf8');
      return { bytes, obj: JSON.parse(bytes) as Settings };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { bytes: null, obj: {} };
      throw err; // parse error / permission error: surfaced by the caller
    }
  }

  /** Describe what an install would change, without touching disk. */
  async plan(ctx: HarnessContext): Promise<HarnessPlan> {
    const hooksDir = this.hooksDir(ctx);
    const willCopy: string[] = [];
    for (const f of await fsp.readdir(this.harnessDir())) {
      if (!f.endsWith('.sh')) continue;
      const dest = path.join(hooksDir, f);
      willCopy.push(dest);
    }
    let obj: Settings = {};
    try {
      ({ obj } = await this.readSettings(ctx));
    } catch {
      /* unparseable settings — plan still lists the hook additions */
    }
    const existing = obj.hooks ?? {};
    const willAddHooks: { event: string; matcher?: string }[] = [];
    for (const spec of HOOK_SPECS) {
      const command = path.join(hooksDir, spec.file);
      const arr = existing[spec.event] ?? [];
      const present = arr.some(
        (g) => Array.isArray(g.hooks) && g.hooks.some((h) => h.command === command),
      );
      if (!present)
        willAddHooks.push({
          event: spec.event,
          ...(spec.matcher ? { matcher: spec.matcher } : {}),
        });
    }
    const lines = [
      `Terminull 하네스 설치 미리보기 (${this.claudeHome(ctx)})`,
      `- 훅 스크립트 ${willCopy.length}개를 ${hooksDir} 에 복사`,
      willAddHooks.length > 0
        ? `- settings.json 훅 항목 ${willAddHooks.length}개 추가: ${willAddHooks.map((h) => h.event + (h.matcher ? `(${h.matcher})` : '')).join(', ')}`
        : '- settings.json 변경 없음 (이미 설치됨)',
    ];
    return { willCopy, willAddHooks, text: lines.join('\n') };
  }

  private async copyHooks(ctx: HarnessContext): Promise<void> {
    const src = this.harnessDir();
    const dst = this.hooksDir(ctx);
    await fsp.mkdir(dst, { recursive: true });
    for (const f of await fsp.readdir(src)) {
      if (!f.endsWith('.sh')) continue;
      await fsp.copyFile(path.join(src, f), path.join(dst, f));
      await fsp.chmod(path.join(dst, f), 0o755);
    }
  }

  async install(ctx: HarnessContext): Promise<HarnessStatus> {
    let read: { bytes: string | null; obj: Settings };
    try {
      read = await this.readSettings(ctx);
    } catch (err) {
      return {
        installed: false,
        detail: {
          en: `settings.json is unreadable/invalid: ${(err as Error).message}`,
          ko: `settings.json을 읽거나 파싱할 수 없습니다: ${(err as Error).message}`,
        },
      };
    }
    await this.copyHooks(ctx);
    const merged = serialize(mergeHooks(read.obj, this.hooksDir(ctx)));
    const settingsPath = this.settingsPath(ctx);

    if (read.bytes !== null && read.bytes === merged) {
      return {
        installed: true,
        detail: { en: 'Already installed (no changes)', ko: '이미 설치됨 (변경 없음)' },
      };
    }
    if (read.bytes !== null) {
      // Back the original up verbatim so uninstall can restore byte-identically.
      await fsp.writeFile(`${settingsPath}.terminull.bak-${Date.now()}`, read.bytes);
    }
    await atomicWrite(settingsPath, merged);
    return {
      installed: true,
      detail: { en: 'Terminull hooks installed', ko: 'Terminull 훅이 설치되었습니다' },
    };
  }

  async uninstall(ctx: HarnessContext): Promise<HarnessStatus> {
    const settingsPath = this.settingsPath(ctx);
    const hooksDir = this.hooksDir(ctx);
    let read: { bytes: string | null; obj: Settings };
    try {
      read = await this.readSettings(ctx);
    } catch (err) {
      return {
        installed: true,
        detail: {
          en: `settings.json unreadable, left untouched: ${(err as Error).message}`,
          ko: `settings.json을 읽을 수 없어 그대로 둡니다: ${(err as Error).message}`,
        },
      };
    }

    // Byte-identical restore: if the current file is exactly what installing the
    // backup would produce, the user made no edits → restore the backup verbatim.
    const backup = await latestBackup(settingsPath);
    if (backup && read.bytes !== null) {
      try {
        const backupBytes = await fsp.readFile(backup, 'utf8');
        const reMerged = serialize(mergeHooks(JSON.parse(backupBytes) as Settings, hooksDir));
        if (reMerged === read.bytes) {
          await atomicWrite(settingsPath, backupBytes);
          await this.removeArtifacts(ctx, { removeBackups: true });
          return {
            installed: false,
            detail: {
              en: 'Restored original settings.json',
              ko: '원본 settings.json을 복원했습니다',
            },
          };
        }
      } catch {
        /* backup unreadable → fall through to structural removal */
      }
    }

    // Structural removal: strip exactly our entries, keep foreign hooks.
    const stripped = stripOurHooks(read.obj, hooksDir);
    if (Object.keys(stripped).length === 0 && read.bytes !== null) {
      // Nothing but our hooks remained → the original was effectively absent.
      try {
        await fsp.unlink(settingsPath);
      } catch {
        /* already gone */
      }
    } else if (read.bytes !== null) {
      await atomicWrite(settingsPath, serialize(stripped));
    }
    await this.removeArtifacts(ctx, { removeBackups: false });
    return {
      installed: false,
      detail: { en: 'Terminull hooks removed', ko: 'Terminull 훅을 제거했습니다' },
    };
  }

  private async removeArtifacts(
    ctx: HarnessContext,
    { removeBackups }: { removeBackups: boolean },
  ): Promise<void> {
    // Remove copied hook scripts + their dir (best-effort).
    const dir = this.hooksDir(ctx);
    try {
      await fsp.rm(dir, { recursive: true, force: true });
      await fsp.rmdir(path.dirname(dir)).catch(() => {});
    } catch {
      /* nothing to remove */
    }
    if (removeBackups) {
      const settingsPath = this.settingsPath(ctx);
      const baseDir = path.dirname(settingsPath);
      const base = path.basename(settingsPath) + '.terminull.bak-';
      try {
        for (const f of await fsp.readdir(baseDir)) {
          if (f.startsWith(base)) await fsp.unlink(path.join(baseDir, f)).catch(() => {});
        }
      } catch {
        /* no backups */
      }
    }
  }

  /** True when every hook file exists AND every settings entry is present. */
  private async markersPresent(ctx: HarnessContext): Promise<boolean> {
    const hooksDir = this.hooksDir(ctx);
    for (const spec of HOOK_SPECS) {
      if (!fs.existsSync(path.join(hooksDir, spec.file))) return false;
    }
    let obj: Settings;
    try {
      ({ obj } = await this.readSettings(ctx));
    } catch {
      return false;
    }
    const hooks = obj.hooks ?? {};
    for (const spec of HOOK_SPECS) {
      const command = path.join(hooksDir, spec.file);
      const arr = hooks[spec.event] ?? [];
      const present = arr.some(
        (g) => Array.isArray(g.hooks) && g.hooks.some((h) => h.command === command),
      );
      if (!present) return false;
    }
    return true;
  }

  async status(ctx: HarnessContext): Promise<HarnessStatus> {
    const installed = await this.markersPresent(ctx);
    return {
      installed,
      detail: installed
        ? { en: 'Terminull hooks present', ko: 'Terminull 훅이 설치되어 있습니다' }
        : { en: 'Terminull hooks not installed', ko: 'Terminull 훅이 설치되어 있지 않습니다' },
    };
  }

  async verify(ctx: HarnessContext): Promise<HarnessStatus> {
    const markers = await this.markersPresent(ctx);
    if (!markers) {
      return {
        installed: false,
        detail: { en: 'Hook markers missing', ko: '훅 표식이 누락되었습니다' },
      };
    }
    // Synthetic panel probe (skipped in tests: no probePanel → markers-only).
    if (this.opts.probePanel) {
      const reachable = await this.opts.probePanel(ctx).catch(() => false);
      return {
        installed: true,
        detail: reachable
          ? { en: 'Installed; panel reachable', ko: '설치됨, 패널 연결됨' }
          : { en: 'Installed; panel not reachable', ko: '설치됨, 패널 미연결' },
      };
    }
    return {
      installed: true,
      detail: { en: 'Installed (markers verified)', ko: '설치됨 (표식 확인)' },
    };
  }
}
