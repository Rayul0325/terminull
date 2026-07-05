import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventStore, NotPostableError } from '../src/store';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminull-store-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function fresh(maxInbox?: number): EventStore {
  const store = new EventStore({ stateDir: dir, maxInbox });
  store.load();
  return store;
}

/** Append ~40 mixed events exercising all three projections. */
function seedMixed(store: EventStore): void {
  store.append('session.start', { sessionId: 'A', actor: 'hook' });
  store.append('session.start', { sessionId: 'B', actor: 'hook' });
  // directives on A: two queued, one delivered → one remains
  store.append('directive.queued', { sessionId: 'A', payload: { directiveId: 'dA1', text: 'go' } });
  store.append('directive.queued', { sessionId: 'A', payload: { directiveId: 'dA2', text: 'stop' } });
  store.append('directive.delivered', { sessionId: 'A', payload: { directiveId: 'dA1' } });
  // directives on B: one queued then cancelled → none remain
  store.append('directive.queued', { sessionId: 'B', payload: { directiveId: 'dB1' } });
  store.append('directive.cancelled', { sessionId: 'B', payload: { directiveId: 'dB1' } });
  // asks: k1 answered, k2 stays open
  store.append('session.ask', { sessionId: 'A', payload: { askId: 'k1', q: '?' } });
  store.append('session.ask', { sessionId: 'B', payload: { askId: 'k2', q: '?' } });
  store.append('ask.answered', { payload: { askId: 'k1' } });
  // needs-permission: A added then cleared by activity, B added and stays
  store.append('session.needs_permission', { sessionId: 'A' });
  store.append('session.needs_permission', { sessionId: 'B' });
  store.append('session.activity', { sessionId: 'A', payload: { kind: 'user_prompt' } });
  // bulk reports from a third session
  for (let i = 0; i < 25; i++) {
    store.append('session.report', { sessionId: 'C', payload: { text: `r${i}` } });
  }
  // D: needs-permission + open ask, then ends → both cleared
  store.append('session.needs_permission', { sessionId: 'D' });
  store.append('session.ask', { sessionId: 'D', payload: { askId: 'k3' } });
  store.append('session.end', { sessionId: 'D' });
}

describe('EventStore — replay determinism', () => {
  it('reproduces identical projections and appends nothing to the file', () => {
    const s1 = fresh();
    seedMixed(s1);

    const snapshot1 = JSON.stringify(s1.projectionSnapshot());
    const bytes1 = fs.statSync(s1.logFile).size;

    // sanity: the seeded end-state is non-trivial
    const proj = s1.projectionSnapshot();
    expect(Object.keys(proj.directives).sort()).toEqual(['A', 'B']);
    expect(proj.directives['A']).toHaveLength(1); // dA2 remains
    expect(proj.directives['B']).toHaveLength(0); // dB1 cancelled
    expect(Object.keys(proj.asks)).toEqual(['k2']); // k1 answered, k3 ended
    expect(proj.needsPermission).toEqual(['B']); // A cleared, D ended

    const s2 = fresh();
    const snapshot2 = JSON.stringify(s2.projectionSnapshot());
    const bytes2 = fs.statSync(s2.logFile).size;

    expect(snapshot2).toBe(snapshot1);
    expect(bytes2).toBe(bytes1); // replay wrote nothing
    expect(s2.seq).toBe(s1.seq);
  });

  it('tolerates a torn final line and keeps appending', () => {
    const s1 = fresh();
    s1.append('session.start', { sessionId: 'A', actor: 'hook' });
    s1.append('session.report', { sessionId: 'A', payload: { text: 'ok' } });

    // simulate a crash mid-append: a half-written JSON line, no newline
    fs.appendFileSync(s1.logFile, '{"seq":999,"ts":1,"v":1,"type":"session.repo');

    const s2 = new EventStore({ stateDir: dir });
    expect(() => s2.load()).not.toThrow();
    expect(s2.seq).toBe(2); // torn line ignored, not folded as seq 999

    const ev = s2.append('session.idle', { sessionId: 'A' });
    expect(ev.seq).toBe(3);
    expect(s2.eventsSince(2).map((e) => e.seq)).toEqual([3]);
  });

  it('throws on a corrupt NON-final line (real corruption)', () => {
    const file = path.join(dir, 'events.jsonl');
    const good1 = JSON.stringify({ seq: 1, ts: 1, v: 1, type: 'session.start', machine: 'local', actor: 'hook', sessionId: 'A' });
    const good2 = JSON.stringify({ seq: 2, ts: 1, v: 1, type: 'session.report', machine: 'local', actor: 'hook', sessionId: 'A' });
    fs.writeFileSync(file, `${good1}\nGARBAGE NOT JSON\n${good2}\n`);

    const store = new EventStore({ stateDir: dir });
    expect(() => store.load()).toThrow(/corrupt/i);
  });
});

describe('EventStore — forgery allowlist (appendExternal)', () => {
  it('accepts postable types and stamps the hook actor', () => {
    const store = fresh();
    const ev = store.appendExternal('session.report', { sessionId: 'A', payload: { text: 'hi' } });
    expect(ev.type).toBe('session.report');
    expect(ev.actor).toBe('hook');
  });

  it('rejects guarded/server-internal types', () => {
    const store = fresh();
    expect(() => store.appendExternal('directive.queued', { sessionId: 'A', payload: { directiveId: 'd' } })).toThrow(
      NotPostableError,
    );
    expect(() => store.appendExternal('ask.answered', { payload: { askId: 'k' } })).toThrow(NotPostableError);
    expect(() => store.appendExternal('permission.settings_changed', {})).toThrow(NotPostableError);
    // a rejected external append leaves no gap and writes nothing
    expect(store.seq).toBe(0);
  });
});

describe('EventStore — needsPermission & ask lifecycle', () => {
  it.each(['session.report', 'session.activity', 'session.idle', 'session.start'])(
    'needs_permission is cleared by a subsequent %s',
    (clearer) => {
      const store = fresh();
      store.append('session.needs_permission', { sessionId: 'S' });
      expect(store.needsPermission.has('S')).toBe(true);
      store.append(clearer, { sessionId: 'S' });
      expect(store.needsPermission.has('S')).toBe(false);
    },
  );

  it('needs_permission is cleared on session.end', () => {
    const store = fresh();
    store.append('session.needs_permission', { sessionId: 'S' });
    store.append('session.end', { sessionId: 'S' });
    expect(store.needsPermission.has('S')).toBe(false);
  });

  it('asks open on session.ask and clear on answered / expired / end', () => {
    const store = fresh();
    store.append('session.ask', { sessionId: 'S', payload: { askId: 'a1' } });
    expect(store.asks.has('a1')).toBe(true);
    store.append('ask.answered', { payload: { askId: 'a1' } });
    expect(store.asks.has('a1')).toBe(false);

    store.append('session.ask', { sessionId: 'S', payload: { askId: 'a2' } });
    store.append('ask.expired', { payload: { askId: 'a2' } });
    expect(store.asks.has('a2')).toBe(false);

    store.append('session.ask', { sessionId: 'T', payload: { askId: 'a3' } });
    expect(store.asks.has('a3')).toBe(true);
    store.append('session.end', { sessionId: 'T' });
    expect(store.asks.has('a3')).toBe(false);
  });
});

describe('EventStore — subscribers', () => {
  it('notifies on append and stops after unsubscribe', () => {
    const store = fresh();
    const seen: number[] = [];
    const unsub = store.subscribe((ev) => seen.push(ev.seq));
    store.append('session.report', { sessionId: 'A' });
    store.append('session.report', { sessionId: 'A' });
    unsub();
    store.append('session.report', { sessionId: 'A' });
    expect(seen).toEqual([1, 2]);
  });
});

describe('EventStore — bounded inbox', () => {
  it('keeps only the last maxInbox events and eventsSince degrades gracefully', () => {
    const store = fresh(10);
    for (let i = 0; i < 60; i++) {
      store.append('session.report', { sessionId: 'X', payload: { i } });
    }
    expect(store.seq).toBe(60);
    expect(store.inbox).toHaveLength(10); // bounded

    // full log is on disk; inbox only holds the window (seq 51..60)
    const since0 = store.eventsSince(0);
    expect(since0).toHaveLength(10);
    expect(since0[0]!.seq).toBe(51);

    // a cursor inside the window returns exactly what follows it
    expect(store.eventsSince(55).map((e) => e.seq)).toEqual([56, 57, 58, 59, 60]);

    // a cursor older than the window returns what remains — no crash
    expect(() => store.eventsSince(5)).not.toThrow();
    expect(store.eventsSince(5)).toHaveLength(10);
  });
});
