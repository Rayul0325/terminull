/**
 * Codex CLI account provider.
 *
 * Honesty is the whole point here:
 *  - `usage` folds the LAST `rate_limits` object seen in recent rollouts (Codex
 *    writes it inside `event_msg` `token_count` payloads). It exposes each window
 *    (`5h` etc. from `window_minutes`) with its `used_percent` and `resets_at`,
 *    plus `asOf` (the event timestamp) and a `staleNote`: Codex only refreshes
 *    these numbers when a turn actually runs, so between turns they are stale.
 *  - `whoami` NEVER parses `auth.json`. It reports PRESENCE only (file exists +
 *    mtime), so the capability `accounts.whoami` is honestly `false`: there is a
 *    login, but the adapter does not read the identity. `whoami()` therefore
 *    returns an honest Unavailable whose reason states the presence status;
 *    {@link CodexAccountProvider.presence} exposes the typed status.
 *  - `listProfiles` mirrors the Claude adapter's `CODEX_HOME` registry pattern.
 *  - `switchProfile` is a typed Unavailable (`accounts.switch` is `false`).
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  AccountProfile,
  AccountProvider,
  AccountResult,
  HarnessContext,
  UsageInfo,
  WhoamiInfo,
} from '@terminull/adapter-sdk';
import { listRollouts } from './collector.js';

const DEFAULT_MAX_SCAN = 8;
const TAIL_BYTES = 256 * 1024;

/** One rate-limit window folded from a Codex `rate_limits` object. */
export interface CodexUsageWindow {
  /** Human window label derived from `window_minutes` (e.g. `'5h'`). */
  label: string;
  /** Percent of the window consumed (`used_percent`). */
  usedPercent: number;
  /** Epoch ms when the window resets (`resets_at`, seconds → ms). */
  resetsAt?: number;
  /** `'primary'` / `'secondary'` — which Codex limit this is. */
  slot: 'primary' | 'secondary';
}

/** Usage snapshot extended with Codex's rate-limit windows + staleness note. */
export interface CodexUsageInfo extends UsageInfo {
  windows: CodexUsageWindow[];
  /** Epoch ms of the `token_count` event these numbers came from. */
  asOf?: number;
  /** i18n key + text for the "updates only when a turn runs" caveat. */
  note: { key: 'codex.usage.staleNote'; text: { en: string; ko: string } };
}

/** Login presence read from `auth.json` existence/mtime (never its content). */
export interface CodexAuthPresence {
  status: 'logged_out' | 'ok-presence-only';
  /** Epoch ms of `auth.json`'s mtime, when present. */
  mtime?: number;
}

/** Codex account provider with the extra typed `presence` accessor. */
export interface CodexAccountProvider extends AccountProvider {
  presence(ctx?: HarnessContext): CodexAuthPresence;
}

/** Options for {@link createCodexAccountProvider}. */
export interface CodexAccountOptions {
  /** Override the `.codex` home (defaults to `<ctx.home ?? homedir>/.codex`). */
  codexHome?: string;
  /** Override the `auth.json` path (defaults to `<codexHome>/auth.json`). */
  authPath?: string;
  /** Terminull data dir holding the profiles registry (defaults to `<home>/.terminull`). */
  dataDir?: string;
  /** How many recent rollouts to scan for the last rate_limits. Default 8. */
  maxScan?: number;
}

/**
 * Read `auth.json` PRESENCE only — never its content. Returns `logged_out` when
 * absent, `ok-presence-only` (with mtime) when present.
 */
export function codexAuthPresence(authPath: string): CodexAuthPresence {
  try {
    const st = fs.statSync(authPath);
    return { status: 'ok-presence-only', mtime: st.mtimeMs };
  } catch {
    return { status: 'logged_out' };
  }
}

function windowLabel(minutes: unknown): string {
  const m = typeof minutes === 'number' && Number.isFinite(minutes) ? minutes : NaN;
  if (!Number.isFinite(m)) return '?';
  if (m % 60 === 0) return `${m / 60}h`;
  return `${m}m`;
}

function foldWindow(slot: 'primary' | 'secondary', obj: unknown): CodexUsageWindow | null {
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const usedPercent = typeof o['used_percent'] === 'number' ? (o['used_percent'] as number) : NaN;
  if (!Number.isFinite(usedPercent)) return null;
  const resets = o['resets_at'];
  // resets_at is epoch SECONDS on this CLI; normalise to ms (leave large values
  // that already look like ms untouched).
  let resetsAt: number | undefined;
  if (typeof resets === 'number' && Number.isFinite(resets)) {
    resetsAt = resets < 1e12 ? resets * 1000 : resets;
  }
  return {
    slot,
    label: windowLabel(o['window_minutes']),
    usedPercent,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}

async function readTail(file: string, bytes = TAIL_BYTES): Promise<string> {
  const fh = await fsp.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    if (len > 0) await fh.read(buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally {
    await fh.close();
  }
}

interface FoldedUsage {
  windows: CodexUsageWindow[];
  asOf?: number;
}

/** Scan newest rollouts for the LAST `token_count` rate_limits and fold it. */
async function foldLastRateLimits(codexHome: string, maxScan: number): Promise<FoldedUsage | null> {
  const rollouts = await listRollouts(path.join(codexHome, 'sessions'));
  rollouts.sort((a, b) => b.mtime - a.mtime);
  for (const r of rollouts.slice(0, maxScan)) {
    let tail: string;
    try {
      tail = await readTail(r.file);
    } catch {
      continue;
    }
    const lines = tail.split('\n');
    // Reverse order in the newest file = the LAST rate_limits chronologically.
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line || line.indexOf('rate_limits') === -1) continue;
      let rec: { timestamp?: string; payload?: Record<string, unknown> };
      try {
        rec = JSON.parse(line) as typeof rec;
      } catch {
        continue; // torn line at the tail edge
      }
      const rl = rec.payload?.['rate_limits'];
      if (!rl || typeof rl !== 'object') continue;
      const o = rl as Record<string, unknown>;
      const windows: CodexUsageWindow[] = [];
      const p = foldWindow('primary', o['primary']);
      const s = foldWindow('secondary', o['secondary']);
      if (p) windows.push(p);
      if (s) windows.push(s);
      if (windows.length === 0) continue;
      const asOf = rec.timestamp ? Date.parse(rec.timestamp) : NaN;
      return { windows, ...(Number.isFinite(asOf) ? { asOf } : {}) };
    }
  }
  return null;
}

const STALE_NOTE = {
  key: 'codex.usage.staleNote' as const,
  text: {
    en: 'Codex refreshes these limits only when a turn runs — between turns they are stale.',
    ko: 'Codex는 턴이 실행될 때만 이 사용량을 갱신합니다 — 턴 사이에는 값이 과거 시점입니다.',
  },
};

function codexHomeOf(opts: CodexAccountOptions, ctx?: HarnessContext): string {
  return opts.codexHome ?? path.join(ctx?.home ?? os.homedir(), '.codex');
}
function authPathOf(opts: CodexAccountOptions, ctx?: HarnessContext): string {
  return opts.authPath ?? path.join(codexHomeOf(opts, ctx), 'auth.json');
}
function dataDirOf(opts: CodexAccountOptions, ctx?: HarnessContext): string {
  return opts.dataDir ?? path.join(ctx?.home ?? os.homedir(), '.terminull');
}

/**
 * Create a Codex CLI account provider bound to the given `.codex` home / auth
 * path / profiles registry. Every method is honest about unavailability.
 */
export function createCodexAccountProvider(opts: CodexAccountOptions = {}): CodexAccountProvider {
  const maxScan = opts.maxScan ?? DEFAULT_MAX_SCAN;

  return {
    presence(ctx?: HarnessContext): CodexAuthPresence {
      return codexAuthPresence(authPathOf(opts, ctx));
    },

    async whoami(ctx?: HarnessContext): Promise<AccountResult<WhoamiInfo>> {
      // Capability accounts.whoami = false: presence only, identity never read.
      const p = codexAuthPresence(authPathOf(opts, ctx));
      return {
        available: false,
        reason:
          p.status === 'ok-presence-only'
            ? {
                en: 'Signed in to Codex (presence only — identity not read for privacy)',
                ko: 'Codex에 로그인됨 (존재만 확인 — 개인정보 보호를 위해 신원은 읽지 않음)',
              }
            : { en: 'Not signed in to Codex', ko: 'Codex에 로그인되어 있지 않습니다' },
      };
    },

    async usage(ctx?: HarnessContext): Promise<AccountResult<UsageInfo>> {
      const folded = await foldLastRateLimits(codexHomeOf(opts, ctx), maxScan);
      if (!folded) {
        return {
          available: false,
          reason: {
            en: 'No Codex usage recorded yet (rate limits appear only after a turn runs)',
            ko: '아직 기록된 Codex 사용량이 없습니다 (사용량은 턴 실행 후에만 나타납니다)',
          },
        };
      }
      const summary = folded.windows
        .map((w) => `${w.label} ${Math.round(w.usedPercent)}%`)
        .join(' · ');
      const value: CodexUsageInfo = {
        label: {
          en: `Rate limits: ${summary} (as of last turn)`,
          ko: `사용량: ${summary} (마지막 턴 기준)`,
        },
        windows: folded.windows,
        note: STALE_NOTE,
        ...(folded.asOf !== undefined ? { asOf: folded.asOf } : {}),
      };
      return { available: true, value };
    },

    async listProfiles(ctx?: HarnessContext): Promise<AccountResult<AccountProfile[]>> {
      const loggedIn = codexAuthPresence(authPathOf(opts, ctx)).status === 'ok-presence-only';
      const profiles: AccountProfile[] = [
        {
          id: 'default',
          label: loggedIn ? 'default (signed in)' : 'default (signed out)',
          active: true,
        },
      ];
      // Additional isolated CODEX_HOME profiles, if a registry exists.
      const registry = path.join(dataDirOf(opts, ctx), 'profiles', 'codex.json');
      try {
        const parsed: unknown = JSON.parse(await fsp.readFile(registry, 'utf8'));
        const list = Array.isArray(parsed) ? parsed : [];
        for (const entry of list) {
          if (entry === null || typeof entry !== 'object') continue;
          const e = entry as Record<string, unknown>;
          const id = typeof e['id'] === 'string' ? (e['id'] as string) : undefined;
          if (!id || id === 'default') continue;
          profiles.push({
            id,
            label: typeof e['label'] === 'string' ? (e['label'] as string) : id,
            active: false,
          });
        }
      } catch {
        /* no registry → just the default profile */
      }
      return { available: true, value: profiles };
    },

    async switchProfile(): Promise<AccountResult<AccountProfile>> {
      // Not implemented in v1 (capability accounts.switch = false). Honest,
      // typed Unavailable rather than a silent no-op.
      return {
        available: false,
        reason: {
          en: 'Switching Codex profiles is not supported in v1',
          ko: 'Codex 프로필 전환은 v1에서 지원되지 않습니다',
        },
      };
    },
  };
}
