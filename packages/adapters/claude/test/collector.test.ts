import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClaudeCollector } from '../src/collector';

let home: string;
let claudeHome: string;

/** A pid that is definitely NOT alive (process.kill throws ESRCH). */
function deadPid(): number {
  for (let pid = 2_000_000; pid < 2_000_050; pid++) {
    try {
      process.kill(pid, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ESRCH') return pid;
    }
  }
  return 2_147_483_646; // fallback: absurdly high, effectively never a real pid
}

function writeSession(pid: number, obj: Record<string, unknown>): void {
  fs.writeFileSync(path.join(claudeHome, 'sessions', `${pid}.json`), JSON.stringify(obj));
}
function writeTranscript(cwd: string, sid: string, records: object[]): string {
  const enc = cwd.replaceAll('/', '-');
  const dir = path.join(claudeHome, 'projects', enc);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sid}.jsonl`);
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-claude-col-'));
  claudeHome = path.join(home, '.claude');
  fs.mkdirSync(path.join(claudeHome, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(claudeHome, 'projects'), { recursive: true });
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('createClaudeCollector', () => {
  it('classifies live (alive pid) vs dead (stale pid) vs recent, and enriches', async () => {
    const liveCwd = '/tmp/live-proj';
    const liveSid = 'live-session-1';
    // Live session: pid = this process (guaranteed alive).
    writeSession(process.pid, {
      pid: process.pid,
      sessionId: liveSid,
      cwd: liveCwd,
      name: 'registry name',
      startedAt: '2026-07-06T00:00:00.000Z',
      kind: 'interactive',
    });
    writeTranscript(liveCwd, liveSid, [
      { type: 'user', message: { content: [{ type: 'text', text: 'hi' }] } },
      { type: 'assistant', aiTitle: 'Enriched Title', cwd: liveCwd, message: { content: [] } },
    ]);

    // Dead session: stale pid → must be skipped.
    writeSession(deadPid(), { pid: deadPid(), sessionId: 'dead-session', cwd: '/tmp/dead' });

    // Two recent (not-live) transcripts under a different project dir.
    const recentCwd = '/tmp/recent-proj';
    writeTranscript(recentCwd, 'recent-a', [
      { type: 'assistant', aiTitle: 'Recent A', cwd: recentCwd, message: { content: [] } },
    ]);
    writeTranscript(recentCwd, 'recent-b', [
      { type: 'assistant', cwd: recentCwd, message: { content: [] } },
    ]);

    const collector = createClaudeCollector({ claudeHome });
    const sessions = await collector.collect({});

    const live = sessions.filter((s) => s.live);
    const recent = sessions.filter((s) => !s.live);

    // exactly one live session, and it is ours (not the dead one).
    expect(live).toHaveLength(1);
    expect(live[0]?.id).toBe(liveSid);
    expect(sessions.some((s) => s.id === 'dead-session')).toBe(false);

    // enrichment: aiTitle overrides the registry name; transcriptRef present.
    expect(live[0]?.title).toBe('Enriched Title');
    expect(live[0]?.cwd).toBe(liveCwd);
    expect(live[0]?.transcriptRef).toEqual({
      kind: 'file',
      path: path.join(claudeHome, 'projects', '-tmp-live-proj', `${liveSid}.jsonl`),
    });

    // both recents discovered, cwd recovered from the transcript for recent-a.
    expect(recent.map((s) => s.id).sort()).toEqual(['recent-a', 'recent-b']);
    expect(recent.find((s) => s.id === 'recent-a')?.cwd).toBe(recentCwd);
  });

  it('returns [] when the claude home does not exist (honest, no throw)', async () => {
    const collector = createClaudeCollector({ claudeHome: path.join(home, 'nope', '.claude') });
    expect(await collector.collect({})).toEqual([]);
  });

  it('exposes watchPaths for the sessions + projects dirs', () => {
    const collector = createClaudeCollector({ claudeHome });
    expect(collector.watchPaths?.({})).toEqual([
      path.join(claudeHome, 'sessions'),
      path.join(claudeHome, 'projects'),
    ]);
  });
});
