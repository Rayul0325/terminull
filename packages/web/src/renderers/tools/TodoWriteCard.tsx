/**
 * TodoWrite tool card — a checklist rendered from `input.todos`
 * ([{content, status}]). Honest by construction: an empty/absent list
 * renders "할 일 없음"; an unrecognized status string (neither completed,
 * in_progress, nor pending) is shown VERBATIM rather than mapped to a
 * fabricated "완료"/"대기" label.
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

interface Todo {
  content: string;
  status: string;
}

function todosOf(input: Record<string, unknown>): Todo[] {
  const raw = input['todos'];
  if (!Array.isArray(raw)) return [];
  const out: Todo[] = [];
  for (const t of raw) {
    if (!t || typeof t !== 'object') continue;
    const obj = t as Record<string, unknown>;
    const content = typeof obj['content'] === 'string' ? (obj['content'] as string) : undefined;
    if (content === undefined) continue;
    const status = typeof obj['status'] === 'string' ? (obj['status'] as string) : 'pending';
    out.push({ content, status });
  }
  return out;
}

export function TodoWriteCard({ item, ctx }: RendererProps): ReactElement {
  const input = inputOf(item.raw);
  const todos = todosOf(input);

  return (
    <ToolCardShell icon="list" eyebrow={ctx.t('chat.toolLabel.TodoWrite')}>
      {todos.length === 0 ? (
        <span style={{ color: 'var(--tn-fg-faint)', fontSize: 12 }}>{ctx.t('chat.todo.empty')}</span>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {todos.map((t, i) => {
            const label =
              t.status === 'completed'
                ? ctx.t('chat.todo.done')
                : t.status === 'in_progress'
                  ? ctx.t('chat.todo.inProgress')
                  : t.status === 'pending'
                    ? ctx.t('chat.todo.pending')
                    : t.status; // unrecognized status: show verbatim, never fabricate
            const tone = t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'running' : 'idle';
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                <Chip tone={tone}>{label}</Chip>
                <span>{t.content}</span>
              </div>
            );
          })}
        </div>
      )}
    </ToolCardShell>
  );
}

registerRenderer({
  id: 'tool.todowrite',
  match: { kind: 'tool_call', toolName: 'TodoWrite' },
  Component: TodoWriteCard,
});
