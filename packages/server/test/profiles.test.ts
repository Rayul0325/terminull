/**
 * M9 GATE ORACLE (d) + profile negatives + keybinding prefs + statusbar seed.
 *
 * The "claude CLI" is a fake shell script that appends its CLAUDE_CONFIG_DIR
 * to a capture file and sleeps — a REAL spawn through the REAL paneld, but
 * never a real agent CLI. Every configHome is a tmpdir pointer whose contents
 * the server must neither read nor create (credential-bridge negative).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { MachineConfig } from '@terminull/shared';
import { createTerminullServer } from '../src/app';
import { api, expectEventually, startStack, type Stack } from './harness';

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fake-agent.mjs',
);

let stack: Stack;

afterEach(async () => {
  await stack.close();
});

/** A fake `claude` binary: records CLAUDE_CONFIG_DIR + argv, then stays alive. */
function writeFakeClaude(dir: string): { cmd: string; capture: string; argsCapture: string } {
  const capture = path.join(dir, 'env-capture.txt');
  const argsCapture = path.join(dir, 'args-capture.txt');
  const cmd = path.join(dir, 'fake-claude.sh');
  fs.writeFileSync(
    cmd,
    `#!/bin/sh\necho "\${CLAUDE_CONFIG_DIR:-unset}" >> "${capture}"\necho "$@" >> "${argsCapture}"\nexec sleep 30\n`,
    { mode: 0o755 },
  );
  return { cmd, capture, argsCapture };
}

function fakeMachine(id: string): MachineConfig {
  return {
    id,
    label: id,
    transport: { kind: 'stdio', cmd: process.execPath, args: [FIXTURE] },
    enabled: true,
  };
}

const captureLines = (file: string): string[] =>
  fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];

describe('GATE oracle (d) — profile switch → new-spawn env only', () => {
  it('switch counts live sessions, injects CLAUDE_CONFIG_DIR into NEW spawns only, never touches the configHome', async () => {
    const tools = fs.mkdtempSync(path.join(os.tmpdir(), 'tn9p-'));
    const { cmd, capture } = writeFakeClaude(tools);
    stack = await startStack({ claudeCmd: cmd });
    const configHome = path.join(tools, 'claude-work');
    fs.mkdirSync(configHome, { recursive: true });
    fs.writeFileSync(path.join(configHome, 'marker.txt'), 'untouched');
    const homeListingBefore = fs.readdirSync(configHome).sort();

    // Register the profile (user-only).
    const create = await api(stack, 'POST', '/api/profiles', {
      user: true,
      body: { id: 'work', toolId: 'claude', label: '업무 계정', configHome },
    });
    expect(create.status).toBe(201);
    expect(create.body.profile).toMatchObject({ id: 'work', toolId: 'claude' });

    // Pre-existing session on the DEFAULT profile.
    const first = await api(stack, 'POST', '/api/sessions', {
      user: true,
      body: { adapterId: 'claude', cwd: stack.stateDir },
    });
    expect(first.status).toBe(201);
    expect(first.body.profile).toBe('default');
    const firstPid = first.body.pid as number;
    await expectEventually(
      () => captureLines(capture),
      (l) => l.length === 1,
      {
        timeoutMs: 10_000,
      },
    );
    expect(captureLines(capture)).toEqual(['unset']); // default = env untouched

    // Switch (user) — live claude session count rides the response.
    const sw = await api(stack, 'POST', '/api/profiles/switch', {
      user: true,
      body: { toolId: 'claude', profileId: 'work' },
    });
    expect(sw.status).toBe(200);
    expect(sw.body).toEqual({
      switched: true,
      toolId: 'claude',
      profileId: 'work',
      liveSessionCount: 1,
    });
    const active = await api(stack, 'GET', '/api/profiles', { user: true });
    expect(active.body.active).toEqual({ claude: 'work' });

    // The PRE-EXISTING session is untouched: same pid, still running, and no
    // restart artefacts (no session.end for it).
    const fleet = await api(stack, 'GET', '/api/fleet', { user: true });
    const survivor = fleet.body.sessions.find((s: any) => s.id === first.body.sessionId);
    expect(survivor?.live).toBe(true);
    const registered = stack.server.registry.get(first.body.sessionId)!;
    expect(registered.running).toBe(true);
    expect(registered.pid).toBe(firstPid); // same process — no restart happened
    const evs = await api(stack, 'GET', '/api/events?since=0', { user: true });
    expect(
      evs.body.events.some(
        (e: any) => e.type === 'session.end' && e.sessionId === first.body.sessionId,
      ),
    ).toBe(false);
    expect(
      evs.body.events.some(
        (e: any) =>
          e.type === 'account.profile_switched' &&
          e.payload.profileId === 'work' &&
          e.payload.liveSessionCount === 1,
      ),
    ).toBe(true);

    // A NEW spawn (no body override) picks up the ACTIVE profile's env.
    const second = await api(stack, 'POST', '/api/sessions', {
      user: true,
      body: { adapterId: 'claude', cwd: stack.stateDir },
    });
    expect(second.status).toBe(201);
    expect(second.body.profile).toBe('work');
    await expectEventually(
      () => captureLines(capture),
      (l) => l.length === 2,
      {
        timeoutMs: 10_000,
      },
    );
    expect(captureLines(capture)[1]).toBe(configHome); // CLAUDE_CONFIG_DIR=<fake>/claude-work

    // Credential-bridge negative: the server neither created nor removed
    // anything under the configHome — it is a pointer, not a store.
    expect(fs.readdirSync(configHome).sort()).toEqual(homeListingBefore);

    // Switching back to default clears the active entry.
    const back = await api(stack, 'POST', '/api/profiles/switch', {
      user: true,
      body: { toolId: 'claude', profileId: 'default' },
    });
    expect(back.status).toBe(200);
    const cleared = await api(stack, 'GET', '/api/profiles', { user: true });
    expect(cleared.body.active).toEqual({});
    fs.rmSync(tools, { recursive: true, force: true });
  }, 30_000);
});

describe('stepper spawn fields (oracle g, server half)', () => {
  it('model + permissionMode ride the spawn body into the CLI argv', async () => {
    const tools = fs.mkdtempSync(path.join(os.tmpdir(), 'tn9g-'));
    const { cmd, argsCapture } = writeFakeClaude(tools);
    stack = await startStack({ claudeCmd: cmd });
    const res = await api(stack, 'POST', '/api/sessions', {
      user: true,
      body: {
        adapterId: 'claude',
        cwd: stack.stateDir,
        model: 'opus',
        permissionMode: 'plan',
      },
    });
    expect(res.status).toBe(201);
    expect(res.body.machine).toBe('local');
    const lines = await expectEventually(
      () => captureLines(argsCapture),
      (l) => l.length === 1,
      {
        timeoutMs: 10_000,
      },
    );
    expect(lines[0]).toBe('--model opus --permission-mode plan');
    fs.rmSync(tools, { recursive: true, force: true });
  }, 20_000);
});

describe('profile negatives', () => {
  it('unknown/agy/remote/agent paths all refuse with typed codes', async () => {
    stack = await startStack({
      machines: [fakeMachine('m1')],
      machineTimings: { heartbeatMs: 200, requestTimeoutMs: 2000 },
    });
    // Spawn override naming an unregistered profile → 400 unknown_profile.
    const unknown = await api(stack, 'POST', '/api/sessions', {
      user: true,
      body: { adapterId: 'claude', cwd: stack.stateDir, profile: 'nope' },
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.code).toBe('unknown_profile');
    // Switch to an unregistered profile → 400 unknown_profile.
    const swUnknown = await api(stack, 'POST', '/api/profiles/switch', {
      user: true,
      body: { toolId: 'claude', profileId: 'nope' },
    });
    expect(swUnknown.status).toBe(400);
    expect(swUnknown.body.code).toBe('unknown_profile');

    // agy has NO verified isolation env → 422 profile_unsupported (honesty).
    const agyHome = path.join(stack.stateDir, 'agy-home');
    fs.mkdirSync(agyHome, { recursive: true });
    const agyCreate = await api(stack, 'POST', '/api/profiles', {
      user: true,
      body: { id: 'alt', toolId: 'agy', label: 'agy alt', configHome: agyHome },
    });
    expect(agyCreate.status).toBe(201);
    const agySwitch = await api(stack, 'POST', '/api/profiles/switch', {
      user: true,
      body: { toolId: 'agy', profileId: 'alt' },
    });
    expect(agySwitch.status).toBe(422);
    expect(agySwitch.body.code).toBe('profile_unsupported');

    // Remote machine + non-default profile → 422 (configHome is local in v1).
    const claudeHome = path.join(stack.stateDir, 'claude-home');
    fs.mkdirSync(claudeHome, { recursive: true });
    await api(stack, 'POST', '/api/profiles', {
      user: true,
      body: { id: 'work', toolId: 'claude', label: 'work', configHome: claudeHome },
    });
    await expectEventually(
      async () => (await api(stack, 'GET', '/api/machines', { user: true })).body.machines,
      (ms: any[]) => ms.find((m) => m.id === 'm1')?.state === 'connected',
      { timeoutMs: 15_000 },
    );
    const remote = await api(stack, 'POST', '/api/sessions', {
      user: true,
      body: { adapterId: 'claude', cwd: stack.stateDir, machine: 'm1', profile: 'work' },
    });
    expect(remote.status).toBe(422);
    expect(remote.body.code).toBe('profile_machine_unsupported');

    // account.switch is agent-FORBIDDEN by default.
    const agentSwitch = await api(stack, 'POST', '/api/profiles/switch', {
      actor: 'agent',
      body: { toolId: 'claude', profileId: 'work' },
    });
    expect(agentSwitch.status).toBe(403);
    expect(agentSwitch.body).toMatchObject({ code: 'forbidden', action: 'account.switch' });

    // Registry mutations are user-only; reserved/duplicate ids are typed.
    const agentCreate = await api(stack, 'POST', '/api/profiles', {
      actor: 'agent',
      body: { id: 'x1', toolId: 'claude', label: 'x', configHome: claudeHome },
    });
    expect(agentCreate.status).toBe(403);
    expect(agentCreate.body.code).toBe('user_required');
    const reserved = await api(stack, 'POST', '/api/profiles', {
      user: true,
      body: { id: 'default', toolId: 'claude', label: 'x', configHome: claudeHome },
    });
    expect(reserved.status).toBe(400);
    expect(reserved.body.code).toBe('profile_id_reserved');
    const dup = await api(stack, 'POST', '/api/profiles', {
      user: true,
      body: { id: 'work', toolId: 'claude', label: 'dup', configHome: claudeHome },
    });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('profile_id_duplicate');
    const relative = await api(stack, 'POST', '/api/profiles', {
      user: true,
      body: { id: 'rel', toolId: 'claude', label: 'rel', configHome: 'relative/path' },
    });
    expect(relative.status).toBe(400);
    expect(relative.body.code).toBe('bad_request');

    // Delete: registry entry only; active falls back to default.
    await api(stack, 'POST', '/api/profiles/switch', {
      user: true,
      body: { toolId: 'claude', profileId: 'work' },
    });
    const del = await api(stack, 'DELETE', '/api/profiles/claude/work', { user: true });
    expect(del.status).toBe(200);
    const after = await api(stack, 'GET', '/api/profiles', { user: true });
    expect(after.body.active).toEqual({});
    expect(fs.existsSync(path.join(claudeHome))).toBe(true); // contents untouched
    const delMissing = await api(stack, 'DELETE', '/api/profiles/claude/work', { user: true });
    expect(delMissing.status).toBe(404);
    const delDefault = await api(stack, 'DELETE', '/api/profiles/claude/default', { user: true });
    expect(delDefault.status).toBe(400);
    expect(delDefault.body.code).toBe('profile_id_reserved');
  }, 40_000);

  it('boot honesty: a corrupt profiles.json refuses to construct the server', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn9pb-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'profiles.json'),
        JSON.stringify({ version: 1, profiles: [], active: { claude: 'ghost' } }),
      );
      expect(() => createTerminullServer({ stateDir: dir })).toThrow(/profiles\.json/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('prefs: keybindings roaming (D6)', () => {
  it('GET seeds empty; PUT is user-only, full-replace, audited by action ids', async () => {
    stack = await startStack();
    const empty = await api(stack, 'GET', '/api/prefs/keybindings', { user: true });
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ version: 1, overrides: {} });

    const agentPut = await api(stack, 'PUT', '/api/prefs/keybindings', {
      actor: 'agent',
      body: { version: 1, overrides: {} },
    });
    expect(agentPut.status).toBe(403);
    expect(agentPut.body.code).toBe('user_required');

    const bad = await api(stack, 'PUT', '/api/prefs/keybindings', {
      user: true,
      body: { version: 2, overrides: {} },
    });
    expect(bad.status).toBe(400);

    const doc = {
      version: 1,
      overrides: { 'workspace.nextTab': 'ctrl+alt+n', 'nav.home': null },
    };
    const put = await api(stack, 'PUT', '/api/prefs/keybindings', { user: true, body: doc });
    expect(put.status).toBe(200);
    expect(put.body).toEqual(doc);
    const roundTrip = await api(stack, 'GET', '/api/prefs/keybindings', { user: true });
    expect(roundTrip.body).toEqual(doc);

    // Audit carries touched ACTION IDS only — combos are prefs, not audit.
    const evs = await api(stack, 'GET', '/api/events?since=0', { user: true });
    const changed = evs.body.events.filter((e: any) => e.type === 'prefs.keybindings_changed');
    expect(changed).toHaveLength(1);
    expect(changed[0].payload).toEqual({ actionIds: ['nav.home', 'workspace.nextTab'] });
    expect(JSON.stringify(changed[0].payload)).not.toContain('ctrl+alt+n');
  });
});

describe('statusbar REST seed (oracle f, server half)', () => {
  const dto = {
    toolId: 'claude',
    toolSessionId: '11111111-2222-3333-4444-555555555555',
    model: { id: 'claude-fable-5', label: 'Fable 5' },
    contextTokens: { used: 156190, max: 1000000, usedPercent: 17.1 },
    costUsd: 0.4212,
    asOf: 1_752_000_000_000,
  };

  it('POST session.status → GET /api/sessions/:sid/status echoes the DTO', async () => {
    stack = await startStack();
    const post = await api(stack, 'POST', '/api/events', {
      body: {
        type: 'session.status',
        tool: 'claude',
        sessionId: dto.toolSessionId,
        payload: dto,
      },
    });
    expect(post.status).toBe(201);
    const seed = await api(stack, 'GET', `/api/sessions/${dto.toolSessionId}/status`, {
      user: true,
    });
    expect(seed.status).toBe(200);
    expect(seed.body.status).toEqual(dto);
  });

  it('invalid payloads are dropped (null seed), never coerced; unknown sid = null', async () => {
    stack = await startStack();
    const post = await api(stack, 'POST', '/api/events', {
      body: {
        type: 'session.status',
        tool: 'claude',
        sessionId: 'sid-bad',
        payload: { ...dto, toolSessionId: 'sid-bad', contextTokens: { used: -5 } },
      },
    });
    expect(post.status).toBe(201); // postable append succeeds — display fold drops
    const seed = await api(stack, 'GET', '/api/sessions/sid-bad/status', { user: true });
    expect(seed.body.status).toBeNull();
    const unknown = await api(stack, 'GET', '/api/sessions/never-seen/status', { user: true });
    expect(unknown.body.status).toBeNull();
  });
});
