/**
 * AskUserQuestionCard resolve + render tests. `t` is the identity-on-key
 * stub, so assertions check for KEY strings. Critically: rendering WITHOUT
 * ctx.pairedResult must never show a fabricated "answer".
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import '../index';
import './AskUserQuestionCard';
import { resolveRenderer, type RendererContext } from '../registry';
import type { ChatItem } from '../../api/types';
import { AskUserQuestionCard } from './AskUserQuestionCard';

function fakeCtx(pairedResult?: ChatItem): RendererContext {
  return {
    adapterId: 'claude',
    sessionId: 's',
    t: ((k: string) => k) as unknown as RendererContext['t'],
    pairedResult,
    openDetail() {},
  };
}

function askItem(input: Record<string, unknown>): ChatItem {
  return {
    id: 'q1',
    role: 'agent',
    kind: 'tool_call',
    raw: { semantic: 'tool_use', name: 'AskUserQuestion', input },
  };
}

describe('AskUserQuestionCard', () => {
  it('resolves to tool.askuserquestion for an AskUserQuestion tool_call', () => {
    const item = askItem({ questions: [] });
    expect(resolveRenderer(item, 'claude').id).toBe('tool.askuserquestion');
  });

  it('renders the question text and option labels, awaiting state when unpaired', () => {
    const item = askItem({
      questions: [
        {
          question: '어느 브랜치로 진행할까요?',
          options: [{ label: 'main' }, { label: 'dev' }],
        },
      ],
    });
    const html = renderToStaticMarkup(<AskUserQuestionCard item={item} ctx={fakeCtx()} />);
    expect(html).toContain('어느 브랜치로 진행할까요?');
    expect(html).toContain('main');
    expect(html).toContain('dev');
    expect(html).toContain('chat.ask.awaiting');
    expect(html).not.toContain('chat.ask.answered');
  });

  it('shows the paired answer text and "answered" state only when a paired result exists', () => {
    const item = askItem({ questions: [{ question: 'q?', options: ['a', 'b'] }] });
    const paired: ChatItem = {
      id: 'res1',
      role: 'tool',
      kind: 'tool_result',
      text: 'main',
      raw: { semantic: 'tool_result', toolUseId: 'x' },
    };
    const html = renderToStaticMarkup(<AskUserQuestionCard item={item} ctx={fakeCtx(paired)} />);
    expect(html).toContain('chat.ask.answered');
    expect(html).toContain('main');
  });

  it('shows the honest "checking" state when no recognizable questions are present', () => {
    const item = askItem({});
    const html = renderToStaticMarkup(<AskUserQuestionCard item={item} ctx={fakeCtx()} />);
    expect(html).toContain('chat.field.checking');
  });
});
