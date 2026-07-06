/**
 * /api/tools/* contract tests — adapter registry listing, usage gauges with
 * honest freshness, account passthrough, and the harness preview/install
 * cycle. Every home is a tmpdir fixture (never the real ~/.codex etc.), no
 * test spawns a real agent CLI, and no credential body is ever written or
 * read (auth.json presence is asserted with an EMPTY placeholder file).
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { UsageGaugeDtoSchema } from '@terminull/shared';
import { api, startStack, type Stack } from './harness';

let stack: Stack;

afterEach(async () => {
  await stack.close();
});

function codexHome(s: Stack): string {
  return path.join(s.collectHome, '.codex');
}

describe('GET /api/tools', () => {
  it('lists all four built-in adapters with declared capabilities only', async () => {
    stack = await startStack();
    const res = await api(stack, 'GET', '/api/tools');
    expect(res.status).toBe(200);
    const ids = res.body.tools.map((t: any) => t.id).sort();
    expect(ids).toEqual(['agy', 'claude', 'codex', 'generic-pty']);
    for (const tool of res.body.tools) {
      expect(tool.displayName.en).toBeTruthy();
      expect(tool.displayName.ko).toBeTruthy();
      expect(tool.capabilities).toBeTypeOf('object');
      // Presence is NOT reported without a probe — honesty over green.
      expect(tool.present).toBeUndefined();
    }
  });
});

describe('GET /api/tools/:toolId/usage', () => {
  it('404s an unknown tool', async () => {
    stack = await startStack();
    const res = await api(stack, 'GET', '/api/tools/nope/usage');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('not_found');
  });

  it('422s a tool without an accounts surface (capability honesty)', async () => {
    stack = await startStack();
    const res = await api(stack, 'GET', '/api/tools/generic-pty/usage');
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'adapter_unsupported', operation: 'usage' });
  });

  it('codex with no recorded usage → honest available:false with a reason', async () => {
    stack = await startStack();
    const res = await api(stack, 'GET', '/api/tools/codex/usage');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      toolId: 'codex',
      available: false,
      windows: [],
      freshness: 'live',
    });
    expect(res.body.reason.en).toBeTruthy();
    expect(res.body.reason.ko).toBeTruthy();
    expect(UsageGaugeDtoSchema.parse(res.body)).toBeTruthy();
  });

  it('codex rollout rate_limits → windows + stale-turn-gated + note passthrough', async () => {
    stack = await startStack();
    const sessions = path.join(codexHome(stack), 'sessions');
    fs.mkdirSync(sessions, { recursive: true });
    const line = JSON.stringify({
      timestamp: '2026-07-06T02:00:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        rate_limits: {
          primary: { used_percent: 42.5, window_minutes: 300, resets_at: 1783500000 },
          secondary: { used_percent: 7.25, window_minutes: 10080 },
        },
      },
    });
    fs.writeFileSync(
      path.join(sessions, 'rollout-2026-07-06-11111111-2222-3333-4444-555555555555.jsonl'),
      `${line}\n`,
    );

    const res = await api(stack, 'GET', '/api/tools/codex/usage');
    expect(res.status).toBe(200);
    const dto = UsageGaugeDtoSchema.parse(res.body);
    expect(dto.toolId).toBe('codex');
    expect(dto.available).toBe(true);
    expect(dto.freshness).toBe('stale-turn-gated');
    expect(dto.asOf).toBe(Date.parse('2026-07-06T02:00:00.000Z'));
    expect(dto.windows).toEqual([
      { label: '5h', usedPercent: 42.5, resetsAt: 1783500000 * 1000, slot: 'primary' },
      { label: '168h', usedPercent: 7.25, slot: 'secondary' },
    ]);
    // The adapter's stale caveat is passed through, never rewritten.
    expect(dto.note?.en).toContain('only when a turn runs');
    expect(dto.note?.ko).toBeTruthy();
  });
});

describe('GET /api/tools/:toolId/account', () => {
  it('codex whoami is presence-only (never parses auth.json), profiles honest', async () => {
    stack = await startStack();
    // Presence placeholder ONLY — deliberately empty, never credential-shaped.
    fs.mkdirSync(codexHome(stack), { recursive: true });
    fs.writeFileSync(path.join(codexHome(stack), 'auth.json'), '');

    const res = await api(stack, 'GET', '/api/tools/codex/account');
    expect(res.status).toBe(200);
    expect(res.body.toolId).toBe('codex');
    // Identity is NOT read → whoami stays unavailable with an honest reason.
    expect(res.body.whoami.available).toBe(false);
    expect(res.body.whoami.reason.en).toContain('presence only');
    expect(res.body.profiles.available).toBe(true);
    expect(res.body.profiles.value[0]).toMatchObject({ id: 'default', active: true });
  });

  it('switch: forbidden for agents by default; typed 422 for codex (unsupported)', async () => {
    stack = await startStack();
    const asAgent = await api(stack, 'POST', '/api/tools/codex/account/switch', {
      body: { profileId: 'other' },
      actor: 'agent',
    });
    expect(asAgent.status).toBe(403);
    expect(asAgent.body.code).toBe('forbidden');

    const asUser = await api(stack, 'POST', '/api/tools/codex/account/switch', {
      body: { profileId: 'other' },
      user: true,
    });
    expect(asUser.status).toBe(422);
    expect(asUser.body.code).toBe('adapter_unsupported');
    expect(asUser.body.operation).toBe('account.switch');
    expect(asUser.body.reason.en).toBeTruthy();
    // No profile switch happened → no event minted.
    expect(stack.server.store.inbox.some((e) => e.type === 'account.profile_switched')).toBe(false);
  });
});

describe('/api/tools/:toolId/harness', () => {
  it('preview is honest before install; install patches the fixture config.toml; uninstall restores it byte-identically', async () => {
    stack = await startStack();
    const home = codexHome(stack);
    fs.mkdirSync(home, { recursive: true });
    const configPath = path.join(home, 'config.toml');
    const original = [
      'model = "gpt-5-codex"',
      '',
      '[projects."/tmp/proj"]',
      'trust_level = "trusted"',
      '',
    ].join('\n');
    fs.writeFileSync(configPath, original);

    // Preview (GET): not installed, files resolved against the fixture home.
    const before = await api(stack, 'GET', '/api/tools/codex/harness');
    expect(before.status).toBe(200);
    expect(before.body.injector.installed).toBe(false);
    expect(before.body.preview.alreadyInstalled).toBe(false);
    const configFile = before.body.files.find((f: any) => f.id === 'codex.config');
    expect(configFile.path).toBe(configPath);
    expect(configFile.exists).toBe(true);
    expect(configFile.riskLevel).toBe('high');
    // No resolver functions leak into the wire shape.
    expect(configFile.pathResolver).toBeUndefined();

    // Install (user actor: harness.edit resolves yes for users).
    const installed = await api(stack, 'POST', '/api/tools/codex/harness', {
      body: {},
      user: true,
    });
    expect(installed.status).toBe(200);
    expect(installed.body).toMatchObject({ toolId: 'codex', op: 'install', installed: true });
    const patched = fs.readFileSync(configPath, 'utf8');
    expect(patched).toContain('notify = [');
    expect(patched).toContain('terminull-codex-notify.sh');
    // The trust table survives byte-for-byte (surgical patch, no reserialize).
    expect(patched).toContain('[projects."/tmp/proj"]');

    const after = await api(stack, 'GET', '/api/tools/codex/harness');
    expect(after.body.injector.installed).toBe(true);

    // Uninstall restores the original config byte-identically.
    const removed = await api(stack, 'DELETE', '/api/tools/codex/harness', {
      body: {},
      user: true,
    });
    expect(removed.status).toBe(200);
    expect(removed.body.installed).toBe(false);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(original);

    // Both edits are audited.
    const edits = stack.server.store.inbox.filter((e) => e.type === 'harness.edited');
    expect(edits.map((e) => (e.payload as any).op)).toEqual(['install', 'uninstall']);
  });

  it('422s a tool without an injector; gates the agent actor to confirm', async () => {
    stack = await startStack();
    const noInjector = await api(stack, 'POST', '/api/tools/generic-pty/harness', {
      body: {},
      user: true,
    });
    expect(noInjector.status).toBe(422);
    expect(noInjector.body).toMatchObject({
      code: 'adapter_unsupported',
      operation: 'harness.edit',
    });

    // harness.edit defaults to confirm for agents → parked, not executed.
    const gated = await api(stack, 'POST', '/api/tools/codex/harness', {
      body: {},
      actor: 'agent',
    });
    expect(gated.status).toBe(202);
    expect(gated.body.code).toBe('pending_confirmation');
  });
});
