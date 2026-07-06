/**
 * Claude Code account provider.
 *
 * Reads ONLY the allowlisted display fields of `oauthAccount` from
 * `~/.claude.json` — {@link WHOAMI_ALLOWLIST}. Credentials live in a separate
 * `.credentials.json` this code never touches; even within `.claude.json` no
 * token/uuid field is read or emitted. Honesty rules:
 *  - missing file / no `oauthAccount` → `logged out` (available:false).
 *  - usage has no machine-readable live quota in v1, so it returns a tier
 *    summary with an explicit note rather than a fabricated number.
 *  - `switchProfile` is not implemented in v1 → typed Unavailable (capability
 *    `accounts.switch` is declared false).
 */
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

/** The ONLY `oauthAccount` fields this provider ever reads. No tokens, no uuids. */
export const WHOAMI_ALLOWLIST = [
  'emailAddress',
  'organizationName',
  'billingType',
  'seatTier',
  'userRateLimitTier',
] as const;

type AllowlistedField = (typeof WHOAMI_ALLOWLIST)[number];
type AllowlistedAccount = Partial<Record<AllowlistedField, string>>;

/** Options for {@link createClaudeAccountProvider}. */
export interface ClaudeAccountOptions {
  /** Path to `.claude.json` (defaults to `<ctx.home ?? homedir>/.claude.json`). */
  claudeJsonPath?: string;
  /** Terminull data dir holding the profiles registry (defaults to `<home>/.terminull`). */
  dataDir?: string;
}

const loggedOut: AccountResult<never> = {
  available: false,
  reason: { en: 'Not signed in to Claude Code', ko: 'Claude Code에 로그인되어 있지 않습니다' },
};

function claudeJsonOf(opts: ClaudeAccountOptions, ctx?: HarnessContext): string {
  return opts.claudeJsonPath ?? path.join(ctx?.home ?? os.homedir(), '.claude.json');
}

function dataDirOf(opts: ClaudeAccountOptions, ctx?: HarnessContext): string {
  return opts.dataDir ?? path.join(ctx?.home ?? os.homedir(), '.terminull');
}

/** Read `.claude.json` and project out ONLY the allowlisted account fields. */
async function readAllowlisted(file: string): Promise<AllowlistedAccount | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const oauth = (parsed as Record<string, unknown>)['oauthAccount'];
  if (oauth === null || typeof oauth !== 'object') return null;
  const src = oauth as Record<string, unknown>;
  const out: AllowlistedAccount = {};
  for (const key of WHOAMI_ALLOWLIST) {
    const v = src[key];
    if (typeof v === 'string' && v.length > 0) out[key] = v;
  }
  return out;
}

function planSummary(a: AllowlistedAccount): string | undefined {
  const parts = [a.seatTier, a.userRateLimitTier, a.billingType].filter(
    (s): s is string => typeof s === 'string' && s.length > 0,
  );
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/**
 * Create a Claude Code account provider bound to the given `.claude.json` and
 * profiles registry. Every method is honest about unavailability.
 */
export function createClaudeAccountProvider(opts: ClaudeAccountOptions = {}): AccountProvider {
  return {
    async whoami(ctx?: HarnessContext): Promise<AccountResult<WhoamiInfo>> {
      const account = await readAllowlisted(claudeJsonOf(opts, ctx));
      if (!account || !account.emailAddress) return loggedOut;
      const plan = planSummary(account);
      const value: WhoamiInfo = {
        account: account.emailAddress,
        ...(plan ? { plan } : {}),
      };
      return { available: true, value };
    },

    async usage(ctx?: HarnessContext): Promise<AccountResult<UsageInfo>> {
      const account = await readAllowlisted(claudeJsonOf(opts, ctx));
      if (!account || !account.emailAddress) return loggedOut;
      const tier = planSummary(account) ?? 'unknown tier';
      // Honest partial: no live quota window is machine-readable in v1.
      const value: UsageInfo = {
        label: {
          en: `Plan: ${tier} (live quota not machine-readable in v1)`,
          ko: `요금제: ${tier} (실시간 사용량은 v1에서 기계 판독 불가)`,
        },
      };
      return { available: true, value };
    },

    async listProfiles(ctx?: HarnessContext): Promise<AccountResult<AccountProfile[]>> {
      // The default profile is the real home; loggedIn iff .claude.json exists.
      const defaultLoggedIn = (await readAllowlisted(claudeJsonOf(opts, ctx))) !== null;
      const profiles: AccountProfile[] = [
        {
          id: 'default',
          label: defaultLoggedIn ? 'default (signed in)' : 'default (signed out)',
          active: true,
        },
      ];
      // Additional isolated CLAUDE_CONFIG_DIR homes, if a registry exists.
      const registry = path.join(dataDirOf(opts, ctx), 'profiles', 'claude.json');
      try {
        const parsed = JSON.parse(await fsp.readFile(registry, 'utf8'));
        const list = Array.isArray(parsed) ? parsed : [];
        for (const entry of list) {
          if (entry === null || typeof entry !== 'object') continue;
          const e = entry as Record<string, unknown>;
          const id = typeof e['id'] === 'string' ? e['id'] : undefined;
          if (!id || id === 'default') continue;
          profiles.push({
            id,
            label: typeof e['label'] === 'string' ? e['label'] : id,
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
          en: 'Switching Claude Code profiles is not supported in v1',
          ko: 'Claude Code 프로필 전환은 v1에서 지원되지 않습니다',
        },
      };
    },
  };
}
