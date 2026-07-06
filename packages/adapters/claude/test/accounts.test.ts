import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClaudeAccountProvider } from '../src/accounts';

let dir: string;
let claudeJsonPath: string;

// A realistic .claude.json shape: allowlisted display fields PLUS token/uuid
// fields the provider must NEVER read or emit.
const CLAUDE_JSON = {
  oauthAccount: {
    emailAddress: 'user@example.com',
    organizationName: "user@example.com's Organization",
    billingType: 'subscription',
    seatTier: 'enterprise',
    userRateLimitTier: 'tier_high',
    accountUuid: 'UUID-MUST-NOT-LEAK-0001',
    organizationUuid: 'ORG-UUID-MUST-NOT-LEAK',
  },
  oauthAccessToken: 'SECRET-TOKEN-MUST-NOT-LEAK',
  primaryApiKey: 'sk-SECRET-MUST-NOT-LEAK',
};

const FORBIDDEN = [
  'SECRET-TOKEN-MUST-NOT-LEAK',
  'sk-SECRET-MUST-NOT-LEAK',
  'UUID-MUST-NOT-LEAK-0001',
  'ORG-UUID-MUST-NOT-LEAK',
];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-claude-acct-'));
  claudeJsonPath = path.join(dir, '.claude.json');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function assertNoSecrets(value: unknown): void {
  const s = JSON.stringify(value);
  for (const secret of FORBIDDEN) expect(s).not.toContain(secret);
}

describe('createClaudeAccountProvider', () => {
  it('whoami returns ONLY allowlisted fields (no tokens/uuids)', async () => {
    fs.writeFileSync(claudeJsonPath, JSON.stringify(CLAUDE_JSON));
    const provider = createClaudeAccountProvider({ claudeJsonPath });
    const res = await provider.whoami();
    expect(res.available).toBe(true);
    if (res.available) {
      expect(res.value.account).toBe('user@example.com');
      expect(res.value.plan).toContain('enterprise');
    }
    assertNoSecrets(res);
  });

  it('usage returns an honest partial with the not-machine-readable note', async () => {
    fs.writeFileSync(claudeJsonPath, JSON.stringify(CLAUDE_JSON));
    const provider = createClaudeAccountProvider({ claudeJsonPath });
    const res = await provider.usage();
    expect(res.available).toBe(true);
    if (res.available) {
      expect(res.value.label.en).toMatch(/not machine-readable/i);
      expect(res.value.label.ko).toMatch(/기계 판독 불가/);
    }
    assertNoSecrets(res);
  });

  it('whoami is logged-out (available:false) when .claude.json is missing', async () => {
    const provider = createClaudeAccountProvider({ claudeJsonPath });
    const res = await provider.whoami();
    expect(res.available).toBe(false);
  });

  it('listProfiles always includes the default profile', async () => {
    fs.writeFileSync(claudeJsonPath, JSON.stringify(CLAUDE_JSON));
    const provider = createClaudeAccountProvider({ claudeJsonPath });
    const res = await provider.listProfiles();
    expect(res.available).toBe(true);
    if (res.available) {
      expect(res.value.some((p) => p.id === 'default' && p.active)).toBe(true);
    }
  });

  it('switchProfile is a typed Unavailable in v1', async () => {
    const provider = createClaudeAccountProvider({ claudeJsonPath });
    const res = await provider.switchProfile('other');
    expect(res.available).toBe(false);
  });
});
