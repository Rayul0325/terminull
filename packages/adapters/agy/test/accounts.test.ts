import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAgyAccountProvider, maskEmailUser } from '../src/accounts';

let dir: string;
let googleAccountsPath: string;

// A realistic google_accounts.json shape: `active` is the signed-in email;
// `old` is a previous account. Only `active` may ever be surfaced.
const GOOGLE_ACCOUNTS = {
  active: 'alice@example.com',
  old: 'old-account@example.com',
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-agy-acct-'));
  googleAccountsPath = path.join(dir, 'google_accounts.json');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('maskEmailUser', () => {
  it('redacts the local-part but keeps the domain', () => {
    expect(maskEmailUser('alice@example.com')).toBe('a***@example.com');
  });
  it('fails closed to [REDACTED] on a non-email string', () => {
    expect(maskEmailUser('not-an-email')).toBe('[REDACTED]');
    expect(maskEmailUser('a@b@c')).toBe('[REDACTED]');
    expect(maskEmailUser('@nolocal.com')).toBe('[REDACTED]');
  });
});

describe('createAgyAccountProvider', () => {
  it('whoami returns the active Google account (direct response field, raw email)', async () => {
    fs.writeFileSync(googleAccountsPath, JSON.stringify(GOOGLE_ACCOUNTS));
    const provider = createAgyAccountProvider({ googleAccountsPath });
    const res = await provider.whoami();
    expect(res.available).toBe(true);
    if (res.available) expect(res.value.account).toBe('alice@example.com');
    // The previous ("old") account is never surfaced.
    expect(JSON.stringify(res)).not.toContain('old-account@example.com');
  });

  it('whoami is logged-out (available:false) when google_accounts.json is missing', async () => {
    const provider = createAgyAccountProvider({ googleAccountsPath });
    const res = await provider.whoami();
    expect(res.available).toBe(false);
  });

  it('whoami is logged-out when there is no active field', async () => {
    fs.writeFileSync(googleAccountsPath, JSON.stringify({ old: 'x@y.com' }));
    const provider = createAgyAccountProvider({ googleAccountsPath });
    const res = await provider.whoami();
    expect(res.available).toBe(false);
  });

  it('usage / listProfiles / switchProfile are honest typed Unavailable', async () => {
    fs.writeFileSync(googleAccountsPath, JSON.stringify(GOOGLE_ACCOUNTS));
    const provider = createAgyAccountProvider({ googleAccountsPath });
    const usage = await provider.usage();
    const profiles = await provider.listProfiles();
    const sw = await provider.switchProfile('x');
    expect(usage.available).toBe(false);
    expect(profiles.available).toBe(false);
    expect(sw.available).toBe(false);
    // No email leaks into the Unavailable reason strings (event-bound).
    for (const r of [usage, profiles, sw]) {
      expect(JSON.stringify(r)).not.toContain('alice@example.com');
    }
  });
});
