/**
 * Fleet `lastActivity` projection (Track A). Each fleet session gets a
 * lightweight "what is it doing right now" field derived from the server's
 * in-memory recent-event window — and an HONEST absent (`undefined`) when there
 * is no activity for it, never a fabricated value.
 */
import { describe, expect, it } from 'vitest';
import type { CollectContext, ToolAdapter } from '@terminull/adapter-sdk';
import { collectFleet, lastActivityForSession } from '../src/fleet';
import { SessionRegistry } from '../src/sessions';

const CTX: CollectContext = { home: '/tmp/terminull-nobody', now: 1_000 };

/** No local adapters — the fleet then contains only paneld/registry sessions. */
function noAdapters(): Map<string, ToolAdapter> {
  return new Map<string, ToolAdapter>();
}

/** A minimal recent-event record (the slice `lastActivityForSession` reads). */
function ev(sessionId: string, payload: unknown): { sessionId: string; payload: unknown } {
  return { sessionId, payload };
}

describe('lastActivityForSession', () => {
  it('returns the raw tool name (+ summary) from the most recent tool event', () => {
    const activity = lastActivityForSession(
      [ev('s', { toolName: 'Bash', description: 'run the test suite' })],
      's',
    );
    expect(activity).toEqual({ toolName: 'Bash', summary: 'run the test suite' });
  });

  it('newest matching event wins (append/oldest-first order)', () => {
    const activity = lastActivityForSession(
      [
        ev('s', { toolName: 'Read', summary: 'old' }),
        ev('s', { toolName: 'Edit', summary: 'new' }),
      ],
      's',
    );
    expect(activity).toEqual({ toolName: 'Edit', summary: 'new' });
  });

  it('falls back to a file path when no explicit description/summary', () => {
    const activity = lastActivityForSession([ev('s', { toolName: 'Read', file: '/a/b.ts' })], 's');
    expect(activity).toEqual({ toolName: 'Read', summary: '/a/b.ts' });
  });

  it('is undefined when no event belongs to the session (honest absent)', () => {
    expect(lastActivityForSession([ev('other', { toolName: 'Bash' })], 's')).toBeUndefined();
  });

  it('is undefined for a non-tool activity event (e.g. a user_prompt) — no fake value', () => {
    // This is the CURRENT session.activity hook payload shape: it carries no
    // toolName/summary, so it must NOT synthesize a lastActivity.
    expect(lastActivityForSession([ev('s', { kind: 'user_prompt' })], 's')).toBeUndefined();
  });

  it('is undefined on an empty window', () => {
    expect(lastActivityForSession([], 's')).toBeUndefined();
  });
});

describe('collectFleet lastActivity enrichment', () => {
  it('sets lastActivity on a session with a recent tool event, undefined otherwise', async () => {
    const registry = new SessionRegistry();
    registry.add({
      id: 'sess-busy',
      sid: 1,
      adapterId: 'claude',
      cwd: '/w',
      label: 'busy',
      running: true,
      createdAt: 10,
    });
    registry.add({
      id: 'sess-quiet',
      sid: 2,
      adapterId: 'claude',
      cwd: '/w',
      label: 'quiet',
      running: true,
      createdAt: 20,
    });

    const snap = await collectFleet(noAdapters(), registry, CTX, [
      ev('unrelated', { toolName: 'Glob' }),
      ev('sess-busy', { toolName: 'Bash', description: 'pnpm test' }),
    ]);

    const busy = snap.sessions.find((s) => s.id === 'sess-busy');
    const quiet = snap.sessions.find((s) => s.id === 'sess-quiet');

    expect(busy?.lastActivity).toEqual({ toolName: 'Bash', summary: 'pnpm test' });
    // A session with no matching recent event stays honestly undefined.
    expect(quiet?.lastActivity).toBeUndefined();
  });

  it('leaves every lastActivity undefined when no event window is supplied', async () => {
    const registry = new SessionRegistry();
    registry.add({
      id: 'sess-x',
      sid: 3,
      adapterId: 'claude',
      cwd: '/w',
      label: 'x',
      running: true,
      createdAt: 30,
    });

    const snap = await collectFleet(noAdapters(), registry, CTX);
    expect(snap.sessions.every((s) => s.lastActivity === undefined)).toBe(true);
  });
});
