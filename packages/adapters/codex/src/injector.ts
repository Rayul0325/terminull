/**
 * Codex CLI harness injector.
 *
 * Codex has exactly ONE hook mechanism: the top-level `notify` array in
 * `config.toml`, which Codex invokes as `notify[0] notify[1..] "turn-ended"
 * <json>` after each turn. This injector wires Terminull's notify wrapper into
 * that array so the panel receives a `codex.turn` event, then chain-execs the
 * ORIGINAL notify client so Codex Desktop behaviour is unchanged (ported from
 * control-tower's `ct-codex-notify.sh`).
 *
 * The patch is SURGICAL — it rewrites ONLY the single `notify = […]` line and
 * NEVER reserializes the TOML. This is load-bearing: `config.toml` holds
 * `[projects."…"]` trust tables (per-directory `trust_level`) that MUST survive
 * byte-identically — a full parse→emit round-trip would reorder keys, drop
 * comments, and re-quote paths, silently changing trust state. Install backs the
 * original up verbatim; uninstall restores it byte-identically when the user made
 * no edits, else surgically removes exactly our array element.
 *
 * Every write test runs against a FAKE home under os.tmpdir(), never the real
 * ~/.codex.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HarnessContext, HarnessInjector, HarnessStatus } from '@terminull/adapter-sdk';

/** The notify wrapper + its shared lib copied into the Codex home. */
export const NOTIFY_SCRIPT = 'terminull-codex-notify.sh';
const HARNESS_FILES = [NOTIFY_SCRIPT, 'terminull-lib.sh'] as const;

const DEFAULT_HARNESS_DIR = fileURLToPath(new URL('../harness/', import.meta.url));

/** Options for {@link CodexNotifyInjector}. */
export interface CodexNotifyInjectorOptions {
  /** Override the `.codex` home (defaults to `<ctx.home ?? homedir>/.codex`). */
  codexHome?: string;
  /** Override the source `harness/` dir (defaults to this package's). */
  harnessDir?: string;
}

/** The diff `plan()` returns — machine-checkable fields plus Korean prose. */
export interface CodexHarnessPlan {
  /** Hook scripts that would be (re)copied. */
  willCopy: string[];
  /** Whether the notify line would be added (true) or prepended-to (false). */
  addsNotifyLine: boolean;
  /** True when our wrapper is already wired (no change). */
  alreadyInstalled: boolean;
  /** Human-readable Korean summary for the panel. */
  text: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Serialise a single-line `notify` regex over the whole file. */
function notifyLineRe(): RegExp {
  return /^([^\S\n]*)notify[^\S\n]*=[^\S\n]*\[([^\]\n]*)\]([^\n]*)$/m;
}

/** Outcome of a surgical patch: the new text + whether a fresh line was added. */
interface PatchResult {
  text: string;
  addedLine: boolean;
  alreadyInstalled: boolean;
  /** Set when the config has a malformed (multi-line) notify array we won't touch. */
  unsupported?: string;
}

/**
 * Surgically wire our notify wrapper into `config.toml` text. Rewrites ONLY the
 * `notify` line (or inserts one before the first table header); everything else
 * is preserved byte-for-byte.
 */
export function patchNotify(text: string, scriptPath: string): PatchResult {
  const scriptTok = `"${scriptPath}"`;
  const m = notifyLineRe().exec(text);

  if (m) {
    const inside = m[2] ?? '';
    if (inside.includes(scriptPath)) {
      return { text, addedLine: false, alreadyInstalled: true };
    }
    // Prepend `"<script>", ` to the existing array, preserving the rest exactly.
    const newInside = inside.trim().length === 0 ? scriptTok : `${scriptTok}, ${inside}`;
    const line = m[0];
    const replaced = line.replace(`[${inside}]`, `[${newInside}]`);
    return {
      text: text.slice(0, m.index) + replaced + text.slice(m.index + line.length),
      addedLine: false,
      alreadyInstalled: false,
    };
  }

  // A `notify =` with no closing `]` on the same line = multi-line array: refuse.
  if (/^[^\S\n]*notify[^\S\n]*=[^\S\n]*\[[^\]\n]*$/m.test(text)) {
    return {
      text,
      addedLine: false,
      alreadyInstalled: false,
      unsupported: 'multi-line notify array is not surgically patchable',
    };
  }

  // No notify line: insert one before the first table header (top-level keys must
  // precede any [table]). Append at EOF when there are no headers.
  const newLine = `notify = [${scriptTok}]\n`;
  const headerRe = /^[^\S\n]*\[/m;
  const hm = headerRe.exec(text);
  if (hm) {
    return {
      text: text.slice(0, hm.index) + newLine + text.slice(hm.index),
      addedLine: true,
      alreadyInstalled: false,
    };
  }
  const sep = text.length === 0 || text.endsWith('\n') ? '' : '\n';
  return { text: text + sep + newLine, addedLine: true, alreadyInstalled: false };
}

/**
 * Surgically remove our notify wrapper from `config.toml` text. If our script is
 * the array's ONLY element the whole `notify` line is removed (we added it);
 * otherwise just our `"<script>", ` prefix is stripped (restoring the original
 * array byte-for-byte).
 */
export function unpatchNotify(text: string, scriptPath: string): string {
  const scriptTok = `"${scriptPath}"`;
  const m = notifyLineRe().exec(text);
  if (!m) return text;
  const inside = m[2] ?? '';
  if (!inside.includes(scriptPath)) return text;

  if (inside.trim() === scriptTok) {
    // We added the whole line — remove it plus its trailing newline.
    const line = m[0];
    let end = m.index + line.length;
    if (text[end] === '\n') end += 1;
    return text.slice(0, m.index) + text.slice(end);
  }
  // We prepended — strip exactly the `"<script>", ` we inserted.
  const prefixRe = new RegExp(`${escapeRegExp(scriptTok)},[^\\S\\n]*`);
  const line = m[0];
  const restored = line.replace(prefixRe, '');
  return text.slice(0, m.index) + restored + text.slice(m.index + line.length);
}

async function atomicWrite(file: string, bytes: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, bytes);
  await fsp.rename(tmp, file);
}

/** Newest `config.toml.terminull.bak-*` for the given config path, if any. */
async function latestBackup(configPath: string): Promise<string | null> {
  const dir = path.dirname(configPath);
  const base = path.basename(configPath) + '.terminull.bak-';
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

/** Installs/removes/verifies Terminull's notify wrapper in a Codex home. */
export class CodexNotifyInjector implements HarnessInjector {
  constructor(private readonly opts: CodexNotifyInjectorOptions = {}) {}

  private codexHome(ctx: HarnessContext): string {
    return this.opts.codexHome ?? path.join(ctx.home ?? os.homedir(), '.codex');
  }
  private hooksDir(ctx: HarnessContext): string {
    return path.join(this.codexHome(ctx), 'terminull', 'hooks');
  }
  private scriptPath(ctx: HarnessContext): string {
    return path.join(this.hooksDir(ctx), NOTIFY_SCRIPT);
  }
  private configPath(ctx: HarnessContext): string {
    return path.join(this.codexHome(ctx), 'config.toml');
  }
  private harnessDir(): string {
    return this.opts.harnessDir ?? DEFAULT_HARNESS_DIR;
  }

  private async readConfig(ctx: HarnessContext): Promise<string | null> {
    try {
      return await fsp.readFile(this.configPath(ctx), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  private async copyScripts(ctx: HarnessContext): Promise<void> {
    const src = this.harnessDir();
    const dst = this.hooksDir(ctx);
    await fsp.mkdir(dst, { recursive: true });
    for (const f of HARNESS_FILES) {
      await fsp.copyFile(path.join(src, f), path.join(dst, f));
      await fsp.chmod(path.join(dst, f), 0o755);
    }
  }

  /** Describe what an install would change, without touching disk. */
  async plan(ctx: HarnessContext): Promise<CodexHarnessPlan> {
    const script = this.scriptPath(ctx);
    const willCopy = HARNESS_FILES.map((f) => path.join(this.hooksDir(ctx), f));
    const original = (await this.readConfig(ctx)) ?? '';
    const patch = patchNotify(original, script);
    const lines = [
      `Terminull Codex 하네스 설치 미리보기 (${this.codexHome(ctx)})`,
      `- notify 래퍼 스크립트 ${willCopy.length}개를 ${this.hooksDir(ctx)} 에 복사`,
      patch.alreadyInstalled
        ? '- config.toml 변경 없음 (이미 설치됨)'
        : patch.unsupported
          ? `- config.toml 변경 불가: ${patch.unsupported}`
          : patch.addedLine
            ? '- config.toml 에 notify 줄 새로 추가'
            : '- config.toml 의 기존 notify 줄에 래퍼를 앞에 연결 (기존 항목 보존)',
    ];
    return {
      willCopy,
      addsNotifyLine: patch.addedLine,
      alreadyInstalled: patch.alreadyInstalled,
      text: lines.join('\n'),
    };
  }

  async install(ctx: HarnessContext): Promise<HarnessStatus> {
    let original: string | null;
    try {
      original = await this.readConfig(ctx);
    } catch (err) {
      return {
        installed: false,
        detail: {
          en: `config.toml is unreadable: ${(err as Error).message}`,
          ko: `config.toml을 읽을 수 없습니다: ${(err as Error).message}`,
        },
      };
    }
    const patch = patchNotify(original ?? '', this.scriptPath(ctx));
    if (patch.unsupported) {
      return {
        installed: false,
        detail: {
          en: `Cannot patch config.toml: ${patch.unsupported}`,
          ko: `config.toml을 수정할 수 없습니다: ${patch.unsupported}`,
        },
      };
    }
    await this.copyScripts(ctx);
    if (patch.alreadyInstalled && original !== null) {
      return {
        installed: true,
        detail: { en: 'Already installed (no changes)', ko: '이미 설치됨 (변경 없음)' },
      };
    }
    const configPath = this.configPath(ctx);
    if (original !== null) {
      // Back the original up verbatim so uninstall can restore byte-identically.
      await fsp.writeFile(`${configPath}.terminull.bak-${Date.now()}`, original);
    }
    await atomicWrite(configPath, patch.text);
    return {
      installed: true,
      detail: {
        en: 'Terminull notify wrapper installed',
        ko: 'Terminull notify 래퍼가 설치되었습니다',
      },
    };
  }

  async uninstall(ctx: HarnessContext): Promise<HarnessStatus> {
    const configPath = this.configPath(ctx);
    const script = this.scriptPath(ctx);
    let current: string | null;
    try {
      current = await this.readConfig(ctx);
    } catch (err) {
      return {
        installed: true,
        detail: {
          en: `config.toml unreadable, left untouched: ${(err as Error).message}`,
          ko: `config.toml을 읽을 수 없어 그대로 둡니다: ${(err as Error).message}`,
        },
      };
    }

    // Byte-identical restore: if the current file is exactly what patching the
    // backup would produce, the user made no edits → restore the backup verbatim.
    const backup = await latestBackup(configPath);
    if (backup && current !== null) {
      try {
        const backupBytes = await fsp.readFile(backup, 'utf8');
        if (patchNotify(backupBytes, script).text === current) {
          await atomicWrite(configPath, backupBytes);
          await this.removeArtifacts(ctx, { removeBackups: true });
          return {
            installed: false,
            detail: {
              en: 'Restored original config.toml',
              ko: '원본 config.toml을 복원했습니다',
            },
          };
        }
      } catch {
        /* backup unreadable → fall through to structural removal */
      }
    }

    // Structural removal: strip exactly our array element (or line).
    if (current !== null) {
      const stripped = unpatchNotify(current, script);
      if (stripped !== current) await atomicWrite(configPath, stripped);
    }
    await this.removeArtifacts(ctx, { removeBackups: false });
    return {
      installed: false,
      detail: {
        en: 'Terminull notify wrapper removed',
        ko: 'Terminull notify 래퍼를 제거했습니다',
      },
    };
  }

  private async removeArtifacts(
    ctx: HarnessContext,
    { removeBackups }: { removeBackups: boolean },
  ): Promise<void> {
    const dir = this.hooksDir(ctx);
    try {
      await fsp.rm(dir, { recursive: true, force: true });
      await fsp.rmdir(path.dirname(dir)).catch(() => {});
    } catch {
      /* nothing to remove */
    }
    if (removeBackups) {
      const configPath = this.configPath(ctx);
      const baseDir = path.dirname(configPath);
      const base = path.basename(configPath) + '.terminull.bak-';
      try {
        for (const f of await fsp.readdir(baseDir)) {
          if (f.startsWith(base)) await fsp.unlink(path.join(baseDir, f)).catch(() => {});
        }
      } catch {
        /* no backups */
      }
    }
  }

  /** True when the scripts exist AND our wrapper is wired into the notify line. */
  private async markersPresent(ctx: HarnessContext): Promise<boolean> {
    for (const f of HARNESS_FILES) {
      if (!fs.existsSync(path.join(this.hooksDir(ctx), f))) return false;
    }
    const config = await this.readConfig(ctx).catch(() => null);
    if (config === null) return false;
    const m = notifyLineRe().exec(config);
    return !!m && (m[2] ?? '').includes(this.scriptPath(ctx));
  }

  async status(ctx: HarnessContext): Promise<HarnessStatus> {
    const installed = await this.markersPresent(ctx);
    return {
      installed,
      detail: installed
        ? {
            en: 'Terminull notify wrapper present',
            ko: 'Terminull notify 래퍼가 설치되어 있습니다',
          }
        : {
            en: 'Terminull notify wrapper not installed',
            ko: 'Terminull notify 래퍼가 설치되어 있지 않습니다',
          },
    };
  }

  async verify(ctx: HarnessContext): Promise<HarnessStatus> {
    const markers = await this.markersPresent(ctx);
    return markers
      ? {
          installed: true,
          detail: { en: 'Installed (markers verified)', ko: '설치됨 (표식 확인)' },
        }
      : {
          installed: false,
          detail: { en: 'Notify wrapper markers missing', ko: 'notify 래퍼 표식이 누락되었습니다' },
        };
  }
}
