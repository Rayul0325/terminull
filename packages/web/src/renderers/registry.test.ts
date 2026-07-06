/**
 * Registry contract tests: built-in resolution, specificity ordering, the
 * mcp__* wildcard, the guaranteed fallback, and tool_use↔tool_result pairing.
 */
import { describe, expect, it } from 'vitest';
import type { ChatItem } from '../api/types';
import './index'; // registers built-ins (side effect, once per process)
import { listRenderers, pairToolResults, registerRenderer, resolveRenderer } from './registry';

function item(partial: Partial<ChatItem> & Pick<ChatItem, 'id' | 'kind' | 'role'>): ChatItem {
  return { ...partial } as ChatItem;
}

const Noop = (): null => null;

describe('resolution', () => {
  it('falls back to generic for unknown tools and unknown kinds', () => {
    const unknownTool = item({
      id: 'a',
      role: 'agent',
      kind: 'tool_call',
      raw: { semantic: 'tool_use', name: 'SomethingNew', input: {} },
    });
    expect(resolveRenderer(unknownTool, 'claude').id).toBe('generic');
    const futureKind = item({ id: 'b', role: 'system', kind: 'hologram' as ChatItem['kind'] });
    expect(resolveRenderer(futureKind, 'claude').id).toBe('generic');
  });

  it('picks the message renderer for text bubbles', () => {
    const msg = item({ id: 'm', role: 'user', kind: 'message', text: 'hi' });
    expect(resolveRenderer(msg, 'claude').id).toBe('kind.message');
  });

  it('picks tool renderers by toolName over kind-level matches', () => {
    const bash = item({
      id: 't',
      role: 'agent',
      kind: 'tool_call',
      raw: { semantic: 'tool_use', name: 'Bash', input: { command: 'ls' } },
    });
    expect(resolveRenderer(bash, 'claude').id).toBe('tool.bash');
    const write = item({
      id: 'w',
      role: 'agent',
      kind: 'tool_call',
      raw: { semantic: 'tool_use', name: 'Write', input: { file_path: '/x', content: 'y' } },
    });
    expect(resolveRenderer(write, 'generic-pty').id).toBe('tool.write');
  });

  it('adapter-specific beats adapter-agnostic at the same tool/kind level', () => {
    registerRenderer({
      id: 'test.bash-claude',
      match: { adapterId: 'claude', kind: 'tool_call', toolName: 'Bash' },
      Component: Noop,
    });
    const bash = item({
      id: 't2',
      role: 'agent',
      kind: 'tool_call',
      raw: { semantic: 'tool_use', name: 'Bash', input: {} },
    });
    expect(resolveRenderer(bash, 'claude').id).toBe('test.bash-claude');
    expect(resolveRenderer(bash, 'codex').id).toBe('tool.bash');
  });

  it('mcp__* wildcard matches mcp tools but loses to an exact name', () => {
    registerRenderer({
      id: 'test.mcp-wildcard',
      match: { kind: 'tool_call', toolName: 'mcp__*' },
      Component: Noop,
    });
    registerRenderer({
      id: 'test.mcp-exact',
      match: { kind: 'tool_call', toolName: 'mcp__kordis__search' },
      Component: Noop,
    });
    const anyMcp = item({
      id: 'x',
      role: 'agent',
      kind: 'tool_call',
      raw: { semantic: 'tool_use', name: 'mcp__github__create_issue', input: {} },
    });
    expect(resolveRenderer(anyMcp, 'claude').id).toBe('test.mcp-wildcard');
    const exact = item({
      id: 'y',
      role: 'agent',
      kind: 'tool_call',
      raw: { semantic: 'tool_use', name: 'mcp__kordis__search', input: {} },
    });
    expect(resolveRenderer(exact, 'claude').id).toBe('test.mcp-exact');
  });

  it('rejects duplicate renderer ids', () => {
    expect(() => registerRenderer({ id: 'generic', match: {}, Component: Noop })).toThrow();
    expect(listRenderers().filter((s) => s.id === 'generic')).toHaveLength(1);
  });
});

describe('pairToolResults', () => {
  it('pairs results to calls by toolUseId and hides paired results', () => {
    const items: ChatItem[] = [
      item({
        id: 'c1',
        role: 'agent',
        kind: 'tool_call',
        raw: { semantic: 'tool_use', name: 'Bash', input: {}, id: 'toolu_1' },
      }),
      item({
        id: 'r1',
        role: 'tool',
        kind: 'tool_result',
        text: 'output',
        raw: { semantic: 'tool_result', toolUseId: 'toolu_1' },
      }),
    ];
    const paired = pairToolResults(items);
    expect(paired.resultByCallId.get('c1')?.id).toBe('r1');
    expect(paired.pairedResultIds.has('r1')).toBe(true);
  });

  it('leaves unpaired results standalone (honest, never dropped)', () => {
    const items: ChatItem[] = [
      item({
        id: 'c1',
        role: 'agent',
        kind: 'tool_call',
        // No raw.id — the in-flight parser extension has not emitted one.
        raw: { semantic: 'tool_use', name: 'Bash', input: {} },
      }),
      item({
        id: 'r9',
        role: 'tool',
        kind: 'tool_result',
        raw: { semantic: 'tool_result', toolUseId: 'toolu_missing' },
      }),
    ];
    const paired = pairToolResults(items);
    expect(paired.resultByCallId.size).toBe(0);
    expect(paired.pairedResultIds.size).toBe(0);
  });

  it('accepts the defensive tool_use_id fallback field', () => {
    const items: ChatItem[] = [
      item({
        id: 'c2',
        role: 'agent',
        kind: 'tool_call',
        raw: { semantic: 'tool_use', name: 'Read', input: {}, id: 'toolu_2' },
      }),
      item({
        id: 'r2',
        role: 'tool',
        kind: 'tool_result',
        raw: { semantic: 'tool_result', tool_use_id: 'toolu_2' },
      }),
    ];
    expect(pairToolResults(items).resultByCallId.get('c2')?.id).toBe('r2');
  });
});
