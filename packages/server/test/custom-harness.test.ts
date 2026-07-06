/**
 * M9 GATE ORACLE (e) — '내 커스텀' detection is READ-ONLY. A fake "real" home
 * (the stack's collectHome tmpdir) is laden with hooks, a statusline, skills/
 * agents/commands and codex MCP tables; the scan must find them while leaving
 * every mtime + content hash byte-identical, creating no files, and NEVER
 * opening the planted credential files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, startStack, type Stack } from './harness';

let stack: Stack;

afterEach(async () => {
  vi.restoreAllMocks();
  await stack.close();
});

interface TreeSnap {
  files: Map<string, { mtimeMs: number; size: number; content: string }>;
}

/** Recursive snapshot of every file under `root` (mtime + raw content). */
function snapshotTree(root: string): TreeSnap {
  const files = new Map<string, { mtimeMs: number; size: number; content: string }>();
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = fs.lstatSync(full);
      if (st.isDirectory()) walk(full);
      else files.set(full, {
        mtimeMs: st.mtimeMs,
        size: st.size,
        content: fs.readFileSync(full, 'latin1'),
      });
    }
  };
  walk(root);
  return { files };
}

function plantFakeHome(home: string): void {
  const claude = path.join(home, '.claude');
  fs.mkdirSync(claude, { recursive: true });
  fs.writeFileSync(
    path.join(claude, 'settings.json'),
    JSON.stringify({
      statusLine: { command: '/Users/u/.claude/statusline.sh' },
      hooks: {
        PostToolUse: [
          {
            matcher: 'Write|Edit',
            hooks: [{ type: 'command', command: '/Users/u/.claude/hooks/format-track.sh' }],
          },
        ],
        Stop: [{ hooks: [{ type: 'command', command: '/Users/u/.claude/hooks/stop-verify.sh' }] }],
      },
    }),
  );
  for (const skill of ['html-report', 'second-brain']) {
    fs.mkdirSync(path.join(claude, 'skills', skill), { recursive: true });
    fs.writeFileSync(path.join(claude, 'skills', skill, 'SKILL.md'), `# ${skill}`);
  }
  fs.mkdirSync(path.join(claude, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(claude, 'agents', 'memory-scribe.md'), 'agent def');
  fs.mkdirSync(path.join(claude, 'commands'), { recursive: true });
  fs.writeFileSync(path.join(claude, 'commands', 'checkpoint.md'), 'cmd def');

  const codex = path.join(home, '.codex');
  fs.mkdirSync(codex, { recursive: true });
  fs.writeFileSync(
    path.join(codex, 'config.toml'),
    ['notify = ["terminull-notify"]', '', '[mcp_servers.kordis]', 'command = "kordis-mcp"'].join(
      '\n',
    ),
  );

  // Credential plants — must never be opened nor listed.
  fs.writeFileSync(path.join(claude, 'auth.json'), '{"never":"read me"}');
  fs.writeFileSync(path.join(codex, 'auth.json'), '{"never":"read me"}');
  fs.writeFileSync(path.join(claude, '.credentials.json'), '{"never":"read me"}');
  // Inside a LISTED directory: skipped without reading, absent from items.
  fs.mkdirSync(path.join(claude, 'skills', 'my-token-helper'), { recursive: true });
}

describe('GATE oracle (e) — GET /api/harness/custom is a read-only scan', () => {
  it('finds hooks/statusline/skills/mcp; tree byte-identical; credentials never opened', async () => {
    stack = await startStack();
    plantFakeHome(stack.collectHome);
    const before = snapshotTree(stack.collectHome);

    // fs-spy half of the credential trap: node:fs is a process-wide singleton,
    // so every read the scanner performs goes through this spy.
    const readSpy = vi.spyOn(fs, 'readFileSync');
    const res = await api(stack, 'GET', '/api/harness/custom', { user: true });
    const readPaths = readSpy.mock.calls.map((c) => String(c[0]));
    readSpy.mockRestore();

    expect(res.status).toBe(200);
    const group = res.body as {
      id: string;
      scannedAt: number;
      truncated: boolean;
      items: { kind: string; toolId: string; label?: string; detail?: string; path: string }[];
    };
    expect(group.id).toBe('custom');
    expect(group.truncated).toBe(false);

    const kinds = (k: string) => group.items.filter((i) => i.kind === k);
    expect(kinds('hook').map((i) => `${i.toolId}:${i.label}`).sort()).toEqual([
      'claude:PostToolUse Write|Edit',
      'claude:Stop',
      'codex:notify',
    ]);
    expect(kinds('hook').find((i) => i.label === 'PostToolUse Write|Edit')?.detail).toBe(
      'format-track.sh',
    );
    expect(kinds('statusline')).toHaveLength(1);
    expect(kinds('statusline')[0]?.detail).toBe('statusline.sh');
    expect(kinds('skill').map((i) => i.label)).toEqual(['html-report', 'second-brain']);
    expect(kinds('agent').map((i) => i.label)).toEqual(['memory-scribe.md']);
    expect(kinds('command').map((i) => i.label)).toEqual(['checkpoint.md']);
    expect(kinds('mcp').map((i) => i.label)).toEqual(['kordis']);

    // Credential names never appear as items…
    const blob = JSON.stringify(group.items);
    expect(blob).not.toContain('auth.json');
    expect(blob).not.toContain('credentials');
    expect(blob).not.toContain('token-helper');
    // …and were never OPENED (fs-spy) — reads stayed on config files only.
    const credentialReads = readPaths.filter(
      (p) => p.startsWith(stack.collectHome) && /auth\.json|credential|token/i.test(p),
    );
    expect(credentialReads).toEqual([]);

    // READ-ONLY proof: every mtime + content byte-identical, no new files.
    const after = snapshotTree(stack.collectHome);
    expect(after.files.size).toBe(before.files.size);
    for (const [p, snap] of before.files) {
      const now = after.files.get(p)!;
      expect(now, p).toBeTruthy();
      expect(now.mtimeMs, p).toBe(snap.mtimeMs);
      expect(now.size, p).toBe(snap.size);
      expect(now.content, p).toBe(snap.content);
    }
  });

  it('a broken settings.json degrades to zero items from that source, never a 500', async () => {
    stack = await startStack();
    const claude = path.join(stack.collectHome, '.claude');
    fs.mkdirSync(path.join(claude, 'skills', 'still-works'), { recursive: true });
    fs.writeFileSync(path.join(claude, 'settings.json'), '{"hooks": {'); // corrupt
    const res = await api(stack, 'GET', '/api/harness/custom', { user: true });
    expect(res.status).toBe(200);
    expect(res.body.items.filter((i: any) => i.kind === 'hook')).toHaveLength(0);
    expect(res.body.items.some((i: any) => i.kind === 'skill' && i.label === 'still-works')).toBe(
      true,
    );
  });

  it('an empty home scans to an empty group (honest, not an error)', async () => {
    stack = await startStack();
    const res = await api(stack, 'GET', '/api/harness/custom', { user: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'custom', items: [], truncated: false });
  });
});
