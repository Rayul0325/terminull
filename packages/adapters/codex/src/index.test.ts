import { describe, expect, it } from 'vitest';
import { codexAdapter } from './index';

describe('@terminull/adapter-codex', () => {
  it('describes the codex tool', () => {
    expect(codexAdapter.tool).toBe('codex');
    expect(codexAdapter.displayName).toBe('Codex');
  });
});
