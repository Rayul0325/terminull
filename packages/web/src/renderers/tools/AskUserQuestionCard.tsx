/**
 * AskUserQuestion tool card — renders the question(s) and their options from
 * the tool_use input. The chosen answer, when shown, comes ONLY from
 * `ctx.pairedResult` (the parser's tool_result pairing) — never fabricated
 * or guessed from the options list. No paired result → the explicit
 * "답변 대기" state.
 */
import type { ReactElement } from 'react';
import type { RendererProps } from '../registry';
import { registerRenderer } from '../registry';
import { Chip } from '../parts/Chip';
import { ToolCardShell } from '../parts/ToolCardShell';

function inputOf(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') {
    const input = (raw as Record<string, unknown>)['input'];
    if (input && typeof input === 'object') return input as Record<string, unknown>;
  }
  return {};
}

interface Question {
  text: string;
  options: string[];
}

function optionLabel(o: unknown): string | undefined {
  if (typeof o === 'string') return o;
  if (o && typeof o === 'object') {
    const label = (o as Record<string, unknown>)['label'];
    if (typeof label === 'string') return label;
  }
  return undefined;
}

function questionsOf(input: Record<string, unknown>): Question[] {
  const raw = input['questions'];
  if (!Array.isArray(raw)) return [];
  const out: Question[] = [];
  for (const q of raw) {
    if (!q || typeof q !== 'object') continue;
    const qObj = q as Record<string, unknown>;
    const text =
      typeof qObj['question'] === 'string'
        ? (qObj['question'] as string)
        : typeof qObj['header'] === 'string'
          ? (qObj['header'] as string)
          : undefined;
    if (text === undefined) continue;
    const optsRaw = qObj['options'];
    const options = Array.isArray(optsRaw)
      ? optsRaw.map(optionLabel).filter((v): v is string => v !== undefined)
      : [];
    out.push({ text, options });
  }
  return out;
}

export function AskUserQuestionCard({ item, ctx }: RendererProps): ReactElement {
  const input = inputOf(item.raw);
  const questions = questionsOf(input);
  const answered = ctx.pairedResult !== undefined;
  const answerText = ctx.pairedResult?.text;

  return (
    <ToolCardShell
      icon="question"
      eyebrow={ctx.t('chat.toolLabel.AskUserQuestion')}
      badges={
        <Chip tone={answered ? 'done' : 'ask'}>
          {answered ? ctx.t('chat.ask.answered') : ctx.t('chat.ask.awaiting')}
        </Chip>
      }
    >
      {questions.length === 0 ? (
        <span style={{ color: 'var(--tn-fg-faint)', fontSize: 12 }}>
          {ctx.t('chat.field.checking')}
        </span>
      ) : (
        questions.map((q, i) => (
          <div key={i} style={{ marginBottom: 6 }}>
            <div style={{ fontSize: 13 }}>{q.text}</div>
            {q.options.length > 0 ? (
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
                {q.options.map((opt, j) => (
                  <Chip key={j}>{opt}</Chip>
                ))}
              </div>
            ) : null}
          </div>
        ))
      )}
      {answered && answerText !== undefined && answerText.length > 0 ? (
        <div style={{ marginTop: 6, fontSize: 12, color: 'var(--tn-fg-muted)' }}>{answerText}</div>
      ) : null}
    </ToolCardShell>
  );
}

registerRenderer({
  id: 'tool.askuserquestion',
  match: { kind: 'tool_call', toolName: 'AskUserQuestion' },
  Component: AskUserQuestionCard,
});
