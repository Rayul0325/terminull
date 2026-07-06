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
  // Mirror Claude Code's real project-dir naming: every non-alphanumeric char
  // (not just '/') is dash-encoded, so fixtures land where the collector looks.
  const enc = cwd.replace(/[^A-Za-z0-9]/g, '-');
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

  it('resolves live transcript paths for cwds with dots/spaces/non-ASCII, and omits ref when absent (regression: 502 transcript_read_failed)', async () => {
    // Two alive pids the collector will accept (injected liveness probe).
    const pidAlive = (pid: number) => pid === 4001 || pid === 4002 || pid === 4003;

    // (1) A cwd with a dot segment. The old `replaceAll('/','-')` left the '.'
    // intact (`-work-.cfg-tower`), missing the real `-work--cfg-tower` dir.
    const dotCwd = '/work/.cfg/tower';
    writeTranscript(dotCwd, 'sid-dot', [
      { type: 'assistant', aiTitle: 'Dot', cwd: dotCwd, message: { content: [] } },
    ]);
    writeSession(4001, { pid: 4001, sessionId: 'sid-dot', cwd: dotCwd });

    // (2) A cwd with a space + non-ASCII segment (the real `오픈랩 2026` case).
    const uniCwd = '/work/오픈랩 2026';
    writeTranscript(uniCwd, 'sid-uni', [
      { type: 'assistant', aiTitle: 'Uni', cwd: uniCwd, message: { content: [] } },
    ]);
    writeSession(4002, { pid: 4002, sessionId: 'sid-uni', cwd: uniCwd });

    // (3) A live session whose transcript was never written → honest: no ref
    // (route degrades to `supported:false`, not a 502 from an ENOENT open).
    writeSession(4003, { pid: 4003, sessionId: 'sid-gone', cwd: '/work/never-written' });

    const collector = createClaudeCollector({ claudeHome, pidAlive });
    const sessions = await collector.collect({});

    for (const [cwd, sid] of [
      [dotCwd, 'sid-dot'],
      [uniCwd, 'sid-uni'],
    ] as const) {
      const s = sessions.find((x) => x.id === sid);
      const expected = path.join(
        claudeHome,
        'projects',
        cwd.replace(/[^A-Za-z0-9]/g, '-'),
        `${sid}.jsonl`,
      );
      expect(s?.transcriptRef).toEqual({ kind: 'file', path: expected });
      expect(fs.existsSync(expected)).toBe(true);
    }

    const gone = sessions.find((x) => x.id === 'sid-gone');
    expect(gone).toBeDefined();
    expect(gone?.transcriptRef).toBeUndefined();
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
