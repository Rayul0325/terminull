import { describe, expect, it } from 'vitest';
import {
  EnvelopeSchema,
  GUARDED_EVENT_TYPES,
  POSTABLE_EVENT_TYPES,
  isPostable,
} from '../src/index';

const validEnvelope = {
  seq: 1,
  ts: 1_700_000_000_000,
  v: 1,
  type: 'session.start',
  machine: 'local',
  actor: 'hook',
} as const;

describe('event vocabulary — forgery allowlist', () => {
  it('marks every postable type postable', () => {
    for (const type of POSTABLE_EVENT_TYPES) {
      expect(isPostable(type)).toBe(true);
    }
  });

  it('marks every guarded type non-postable', () => {
    for (const type of GUARDED_EVENT_TYPES) {
      expect(isPostable(type)).toBe(false);
    }
  });

  it('treats unknown types as non-postable', () => {
    expect(isPostable('totally.unknown')).toBe(false);
    expect(isPostable('')).toBe(false);
  });

  it('keeps the two vocabularies disjoint', () => {
    const postable = new Set<string>(POSTABLE_EVENT_TYPES);
    for (const type of GUARDED_EVENT_TYPES) {
      expect(postable.has(type)).toBe(false);
    }
  });
});

describe('EnvelopeSchema', () => {
  it('accepts a well-formed envelope', () => {
    expect(() => EnvelopeSchema.parse({ ...validEnvelope })).not.toThrow();
  });

  it('accepts optional tool/sessionId/payload', () => {
    expect(() =>
      EnvelopeSchema.parse({
        ...validEnvelope,
        tool: 'claude',
        sessionId: 'abc',
        payload: { anything: true },
      }),
    ).not.toThrow();
  });

  it('rejects a wrong version literal', () => {
    expect(() => EnvelopeSchema.parse({ ...validEnvelope, v: 2 })).toThrow();
  });

  it('rejects a missing machine', () => {
    const noMachine = { seq: 1, ts: 1_700_000_000_000, v: 1, type: 'session.start', actor: 'hook' };
    expect(() => EnvelopeSchema.parse(noMachine)).toThrow();
  });

  it('rejects an unknown actor', () => {
    expect(() => EnvelopeSchema.parse({ ...validEnvelope, actor: 'nobody' })).toThrow();
  });

  it('rejects extra top-level keys (strict)', () => {
    expect(() => EnvelopeSchema.parse({ ...validEnvelope, forged: 1 })).toThrow();
  });
});
