/**
 * Antigravity (`agy`) account provider.
 *
 * Reads ONLY the `active` field of `<geminiHome>/google_accounts.json` — the
 * currently signed-in Google account email. No token, no oauth cred, no
 * `installation_id` is ever read (credentials live in `oauth_creds.json`, which
 * this code never touches). Honesty rules:
 *  - missing file / no `active` → `logged out` (available:false).
 *  - usage / profiles / switch have no honest local source → typed Unavailable
 *    (capabilities `accounts.usage/profiles/switch` are all declared false).
 *
 * Masking convention (mirrors `@terminull/core` `maskSecrets`): the raw email is
 * returned ONLY in the direct API-response field ({@link WhoamiInfo.account}).
 * Anywhere an email would become part of an EVENT-BOUND string (a log line, a
 * notification, an emitted control frame), callers must first run
 * {@link maskEmailUser}, which redacts the local-part while keeping the domain.
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

/** Options for {@link createAgyAccountProvider}. */
export interface AgyAccountOptions {
  /** Override the `.gemini` home (defaults to `<ctx.home ?? homedir>/.gemini`). */
  geminiHome?: string;
  /**
   * Override the `google_accounts.json` path (defaults to
   * `<geminiHome>/google_accounts.json`).
   */
  googleAccountsPath?: string;
}

const loggedOut: AccountResult<never> = {
  available: false,
  reason: { en: 'Not signed in to Antigravity', ko: 'Antigravity에 로그인되어 있지 않습니다' },
};

const usageUnavailable: AccountResult<UsageInfo> = {
  available: false,
  reason: {
    en: 'Antigravity exposes no machine-readable usage/quota',
    ko: 'Antigravity는 기계 판독 가능한 사용량/할당량을 제공하지 않습니다',
  },
};

const profilesUnavailable: AccountResult<AccountProfile[]> = {
  available: false,
  reason: {
    en: 'Antigravity account profiles are not enumerable',
    ko: 'Antigravity 계정 프로필은 열거할 수 없습니다',
  },
};

/**
 * Redact the local-part of an email, keeping the domain (event-safe form).
 * `alice@example.com` → `a***@example.com`. A string without a single `@`
 * becomes the literal `[REDACTED]` (fail-closed, no partial leak).
 */
export function maskEmailUser(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0 || at !== email.lastIndexOf('@')) return '[REDACTED]';
  const first = email.slice(0, 1);
  return `${first}***${email.slice(at)}`;
}

function googleAccountsPathOf(opts: AgyAccountOptions, ctx?: HarnessContext): string {
  if (opts.googleAccountsPath) return opts.googleAccountsPath;
  const geminiHome = opts.geminiHome ?? path.join(ctx?.home ?? os.homedir(), '.gemini');
  return path.join(geminiHome, 'google_accounts.json');
}

/** Read the `active` account email from `google_accounts.json`, or null. */
async function readActiveAccount(file: string): Promise<string | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const active = (parsed as Record<string, unknown>)['active'];
  return typeof active === 'string' && active.length > 0 ? active : null;
}

/**
 * Create an agy account provider bound to the given `google_accounts.json`.
 * `whoami` reports the active Google account; every other method is an honest
 * typed Unavailable.
 */
export function createAgyAccountProvider(opts: AgyAccountOptions = {}): AccountProvider {
  return {
    async whoami(ctx?: HarnessContext): Promise<AccountResult<WhoamiInfo>> {
      const account = await readActiveAccount(googleAccountsPathOf(opts, ctx));
      if (!account) return loggedOut;
      // Raw email is allowed here — this is the direct API-response field, not an
      // event-bound string. Callers emitting it into logs/frames mask it first.
      return { available: true, value: { account } };
    },

    usage(): Promise<AccountResult<UsageInfo>> {
      return Promise.resolve(usageUnavailable);
    },

    listProfiles(): Promise<AccountResult<AccountProfile[]>> {
      return Promise.resolve(profilesUnavailable);
    },

    switchProfile(): Promise<AccountResult<AccountProfile>> {
      return Promise.resolve({
        available: false,
        reason: {
          en: 'Switching Antigravity accounts is not supported',
          ko: 'Antigravity 계정 전환은 지원되지 않습니다',
        },
      });
    },
  };
}
