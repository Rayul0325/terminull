import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCodexAccountProvider, codexAuthPresence } from '../src/usage';
import type { CodexUsageInfo } from '../src/usage';

let home: string;
let codexHome: string;

const SID = '019f3385-697e-70b3-b728-f2c9c9d0bac5';

function writeRolloutWithUsage(): void {
  const dir = path.join(codexHome, 'sessions', '2026', '07', '06');
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    { type: 'session_meta', payload: { cwd: '/p', originator: 'cli' } },
    {
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    },
    {
      timestamp: '2026-07-06T03:23:29.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        rate_limits: {
          primary: { used_percent: 42.5, window_minutes: 300, resets_at: 1782459473 },
          secondary: { used_percent: 10, window_minutes: 10080, resets_at: 1782999999 },
          plan_type: 'plus',
        },
      },
    },
  ];
  fs.writeFileSync(
    path.join(dir, `rollout-2026-07-06T03-23-29-${SID}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
  );
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-codex-usage-'));
  codexHome = path.join(home, '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('createCodexAccountProvider — usage', () => {
  it('folds the last rate_limits into windows with staleness note + asOf', async () => {
    writeRolloutWithUsage();
    const provider = createCodexAccountProvider({ codexHome });
    const res = await provider.usage();
    expect(res.available).toBe(true);
    if (!res.available) return;
    const value = res.value as CodexUsageInfo;
    expect(value.windows).toEqual([
      { slot: 'primary', label: '5h', usedPercent: 42.5, resetsAt: 1782459473 * 1000 },
      { slot: 'secondary', label: '168h', usedPercent: 10, resetsAt: 1782999999 * 1000 },
    ]);
    expect(value.asOf).toBe(Date.parse('2026-07-06T03:23:29.000Z'));
    expect(value.note.key).toBe('codex.usage.staleNote');
    expect(value.note.text.ko).toMatch(/턴/);
    expect(value.label.ko).toContain('마지막 턴');
  });

  it('is honestly Unavailable when no rate_limits have been recorded', async () => {
    const provider = createCodexAccountProvider({ codexHome });
    const res = await provider.usage();
    expect(res.available).toBe(false);
  });
});

describe('createCodexAccountProvider — whoami presence (never parses auth.json)', () => {
  it('reports presence-only Unavailable when auth.json exists', async () => {
    fs.writeFileSync(path.join(codexHome, 'auth.json'), '{"OPENAI_API_KEY":"MUST-NOT-BE-READ"}');
    const provider = createCodexAccountProvider({ codexHome });
    const res = await provider.whoami();
    expect(res.available).toBe(false); // capability whoami=false: no identity read
    if (!res.available) {
      expect(res.reason.en).toMatch(/presence only/i);
      // The secret content must never surface anywhere.
      expect(JSON.stringify(res)).not.toContain('MUST-NOT-BE-READ');
    }
    expect(provider.presence().status).toBe('ok-presence-only');
  });

  it('reports logged-out when auth.json is absent', async () => {
    const provider = createCodexAccountProvider({ codexHome });
    const res = await provider.whoami();
    expect(res.available).toBe(false);
    if (!res.available) expect(res.reason.en).toMatch(/not signed in/i);
    expect(provider.presence().status).toBe('logged_out');
  });

  it('codexAuthPresence is a pure existence/mtime check', () => {
    const p = path.join(codexHome, 'auth.json');
    expect(codexAuthPresence(p).status).toBe('logged_out');
    fs.writeFileSync(p, 'x');
    const present = codexAuthPresence(p);
    expect(present.status).toBe('ok-presence-only');
    expect(typeof present.mtime).toBe('number');
  });
});

describe('createCodexAccountProvider — profiles', () => {
  it('always includes the default profile and merges a CODEX_HOME registry', async () => {
    fs.writeFileSync(path.join(codexHome, 'auth.json'), 'x');
    const dataDir = path.join(home, '.terminull');
    fs.mkdirSync(path.join(dataDir, 'profiles'), { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, 'profiles', 'codex.json'),
      JSON.stringify([{ id: 'work', label: 'Work Codex' }]),
    );
    const provider = createCodexAccountProvider({ codexHome, dataDir });
    const res = await provider.listProfiles();
    expect(res.available).toBe(true);
    if (res.available) {
      expect(res.value.find((p) => p.id === 'default')?.active).toBe(true);
      expect(res.value.find((p) => p.id === 'default')?.label).toContain('signed in');
      expect(res.value.some((p) => p.id === 'work')).toBe(true);
    }
  });

  it('switchProfile is a typed Unavailable in v1', async () => {
    const provider = createCodexAccountProvider({ codexHome });
    const res = await provider.switchProfile('work');
    expect(res.available).toBe(false);
  });
});
