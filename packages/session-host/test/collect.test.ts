/**
 * Agent-side collector unit tests, all against FAKE tool homes under a
 * tmpdir — the real ~/.claude / ~/.codex are never touched. Verifies the
 * honesty contract: pid-verified liveness only, absent homes are successful
 * zero-session scans, and every reply is wire-valid (CollectedSchema).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CollectedSchema, type RemoteSession } from '@terminull/shared';
import { createAgentCollector } from '../src/collect';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tn8-home-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

/** Write a fake claude pid-registry entry. */
function claudeRegistry(name: string, body: Record<string, unknown>): void {
  const dir = path.join(home, '.claude', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify(body));
}

/** Touch a fake claude project transcript. */
function claudeTranscript(project: string, sid: string): void {
  const dir = path.join(home, '.claude', 'projects', project);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sid}.jsonl`), '{"type":"noise"}\n');
}

function bySessionId(sessions: RemoteSession[]): Map<string, RemoteSession> {
  return new Map(sessions.map((s) => [s.id, s]));
}

describe('createAgentCollector', () => {
  it('reports pid-verified claude live sessions + mtime recents; absent codex home is an honest zero', async () => {
    const now = Date.now();
    claudeRegistry('101.json', {
      pid: 101,
      sessionId: 'live-1',
      cwd: '/tmp/proj',
      name: 'Live one',
      updatedAt: now,
    });
    claudeRegistry('102.json', { pid: 102, sessionId: 'dead-1', cwd: '/tmp/proj' });
    claudeTranscript('-tmp-proj', 'dead-1'); // dead registry pid → recent via transcript
    claudeTranscript('-tmp-proj', 'recent-1');

    const collect = createAgentCollector({ home, pidAlive: (pid) => pid === 101 });
    const result = await collect();

    expect(result.supported).toBe(true);
    expect(result.adapters).toEqual([
      { adapterId: 'claude', ok: true, sessions: 3 },
      { adapterId: 'codex', ok: true, sessions: 0 }, // no .codex home: honest zero, not an error
    ]);

    const sessions = bySessionId(result.sessions);
    expect(sessions.get('live-1')).toMatchObject({
      tool: 'claude',
      live: true,
      cwd: '/tmp/proj',
      title: 'Live one',
      updatedAt: now,
    });
    // Liveness is pid-VERIFIED: a dead registry pid must not surface as live.
    expect(sessions.get('dead-1')?.live).toBe(false);
    expect(sessions.get('recent-1')?.live).toBe(false);

    // Wire validity: the full reply must satisfy the strict schema
    // (updatedAt integers included — mtimeMs floats must have been rounded).
    expect(() => CollectedSchema.parse({ t: 'collected', reqId: 'r', ...result })).not.toThrow();
  });

  it('reports codex rollouts live:false (no liveness API) with titles from session_index', async () => {
    const uuid = '01234567-89ab-cdef-0123-456789abcdef';
    const dayDir = path.join(home, '.codex', 'sessions', '2026', '07', '06');
    fs.mkdirSync(dayDir, { recursive: true });
    fs.writeFileSync(path.join(dayDir, `rollout-2026-07-06T10-00-00-${uuid}.jsonl`), '{}\n');
    fs.writeFileSync(
      path.join(home, '.codex', 'session_index.jsonl'),
      JSON.stringify({ id: uuid, thread_name: 'old name' }) +
        '\n' +
        JSON.stringify({ id: uuid, thread_name: 'newest name' }) +
        '\n',
    );

    const result = await createAgentCollector({ home, pidAlive: () => false })();
    expect(result.adapters).toEqual([
      { adapterId: 'claude', ok: true, sessions: 0 },
      { adapterId: 'codex', ok: true, sessions: 1 },
    ]);
    const codex = result.sessions[0]!;
    expect(codex).toMatchObject({ id: uuid, tool: 'codex', live: false, title: 'newest name' });
    expect(Number.isInteger(codex.updatedAt)).toBe(true);
    expect(() => CollectedSchema.parse({ t: 'collected', reqId: 'r', ...result })).not.toThrow();
  });

  it('an empty home yields supported:true with zero sessions everywhere (never a throw)', async () => {
    const result = await createAgentCollector({ home })();
    expect(result).toEqual({
      supported: true,
      adapters: [
        { adapterId: 'claude', ok: true, sessions: 0 },
        { adapterId: 'codex', ok: true, sessions: 0 },
      ],
      sessions: [],
    });
  });

  it('skips unreadable registry entries instead of failing the scan', async () => {
    claudeRegistry('broken.json', {}); // rewritten below with invalid JSON
    fs.writeFileSync(path.join(home, '.claude', 'sessions', 'broken.json'), '{not json');
    claudeRegistry('ok.json', { pid: 7, sessionId: 'ok-1' });

    const result = await createAgentCollector({ home, pidAlive: () => true })();
    expect(result.adapters[0]).toEqual({ adapterId: 'claude', ok: true, sessions: 1 });
    expect(result.sessions.map((s) => s.id)).toEqual(['ok-1']);
  });
});
