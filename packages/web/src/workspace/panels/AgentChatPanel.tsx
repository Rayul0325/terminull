/**
 * Supervisor chat panel — the manage-agent conversation surface (dockview
 * panel type 'agent', registered like every built-in).
 *
 * Wire: POST /api/agent/chat (202 = accepted, turn runs async) + the
 * `agent.speech`/`agent.state`/`agent.action` events the global ingest loop
 * feeds into the agentChat store. The header shows /api/agent/status honestly:
 * brain availability 'unverified' is its own chip (never green), budget is
 * "unknown" when the brain reports no cost. Proposed/executed/refused actions
 * render as compact phase chips inline under their turn; chips whose proposal
 * became a confirmation deep-link to the inbox card. The model selector is fed
 * from the dynamic registry endpoint and honestly labeled as not yet applied
 * to chat turns (the contracted body is {text} only).
 */
import { useEffect, type ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { AgentActionPayload, AgentRuntimeState, BrainAvailability } from '@terminull/shared';
import { useAgentChatStore, type ActionChip, type ChatMessage } from '../../stores/agentChat';

/**
 * The tool whose model registry feeds the selector. The v1 brain is
 * claude-headless (M7 contract §4), so the claude adapter's registry applies.
 */
const MODEL_REGISTRY_TOOL = 'claude';

const AVAILABILITY_DOT: Record<BrainAvailability, string> = {
  ok: 'tn-dot--live',
  unverified: 'tn-dot--warn',
  unavailable: 'tn-dot--down',
};

const PHASE_COLOR: Record<AgentActionPayload['phase'], string> = {
  proposed: 'var(--tn-fg-muted)',
  pending: 'var(--tn-warn)',
  approved: 'var(--tn-ok)',
  denied: 'var(--tn-danger)',
  executed: 'var(--tn-ok)',
  failed: 'var(--tn-danger)',
};

function StatusHeader(): ReactElement {
  const { t } = useTranslation();
  const status = useAgentChatStore((s) => s.status);
  const statusErrorCode = useAgentChatStore((s) => s.statusErrorCode);
  const runtimeState = useAgentChatStore((s) => s.runtimeState);
  const runtimeReason = useAgentChatStore((s) => s.runtimeReason);

  const state: AgentRuntimeState | null = runtimeState ?? status?.state ?? null;
  return (
    <div
      style={{
        display: 'flex',
        gap: 6,
        alignItems: 'center',
        flexWrap: 'wrap',
        padding: '6px 8px',
        borderBottom: '1px solid var(--tn-border)',
      }}
    >
      {status !== null ? (
        <span className="tn-chip" title={status.brain.id}>
          <span className={`tn-dot ${AVAILABILITY_DOT[status.brain.availability]}`} />
          {status.brain.id}
          {' · '}
          {t(`agent.availability.${status.brain.availability}`)}
        </span>
      ) : null}
      {state !== null ? (
        <span className="tn-chip">
          {t(`agent.state.${state}`, { defaultValue: state })}
          {runtimeReason !== undefined ? ` (${runtimeReason})` : ''}
        </span>
      ) : null}
      {status !== null && status.pendingApprovals > 0 ? (
        <Link to="/" className="tn-chip" style={{ color: 'var(--tn-warn)' }}>
          {t('agent.status.pending', { count: status.pendingApprovals })}
        </Link>
      ) : null}
      {status !== null ? (
        <span className="tn-chip">
          {status.budget.spentUsd !== null
            ? t('agent.status.budgetSpent', { spent: status.budget.spentUsd.toFixed(2) })
            : t('agent.status.budgetUnknown')}
        </span>
      ) : null}
      {statusErrorCode !== null ? (
        <span className="tn-chip" style={{ color: 'var(--tn-danger)' }}>
          {t('agent.status.loadFailed', { code: statusErrorCode })}
        </span>
      ) : null}
    </div>
  );
}

function PhaseChip({ chip }: { chip: ActionChip }): ReactElement {
  const { t } = useTranslation();
  const body = (
    <>
      <span style={{ color: PHASE_COLOR[chip.phase] }}>
        {t(`agent.phase.${chip.phase}`, { defaultValue: chip.phase })}
      </span>
      {' · '}
      {t(`agent.kind.${chip.actionKind}`, { defaultValue: chip.actionKind })}
      {chip.resultCode !== undefined ? (
        <code style={{ fontFamily: 'var(--tn-font-mono)', fontSize: 11 }}>{chip.resultCode}</code>
      ) : null}
    </>
  );
  // Proposals parked as confirmations deep-link to their inbox card.
  return chip.confirmationId !== undefined ? (
    <Link
      to={{ pathname: '/', hash: `#approval-${chip.confirmationId}` }}
      className="tn-chip"
      style={{ textDecoration: 'none' }}
      title={t('agent.chip.viewApproval')}
    >
      {body}
    </Link>
  ) : (
    <span className="tn-chip">{body}</span>
  );
}

function MessageRow({
  message,
  chips,
}: {
  message: ChatMessage;
  chips: ActionChip[];
}): ReactElement {
  const { t } = useTranslation();
  const isUser = message.kind === 'user';
  return (
    <div style={{ display: 'grid', gap: 4, justifyItems: isUser ? 'end' : 'start' }}>
      <div
        style={{
          maxWidth: '85%',
          padding: '8px 10px',
          borderRadius: 'var(--tn-radius)',
          background: isUser ? 'var(--tn-accent)' : 'var(--tn-bg-elevated)',
          color: isUser ? 'var(--tn-accent-fg)' : 'var(--tn-fg)',
          border: isUser ? 'none' : '1px solid var(--tn-border)',
          whiteSpace: 'pre-wrap',
        }}
      >
        {message.text}
      </div>
      {isUser ? (
        <span
          className="tn-chip"
          style={message.state === 'failed' ? { color: 'var(--tn-danger)' } : {}}
        >
          {message.state === 'sending' ? t('agent.chat.sending') : null}
          {message.state === 'accepted' ? t('agent.chat.accepted') : null}
          {message.state === 'failed'
            ? t('agent.chat.failed', { code: message.errorCode ?? '' })
            : null}
        </span>
      ) : null}
      {!isUser && !message.final ? (
        <span className="tn-chip">{t('agent.chat.streaming')}</span>
      ) : null}
      {chips.length > 0 ? (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {chips.map((c) => (
            <PhaseChip key={c.proposalId} chip={c} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ModelSelector(): ReactElement {
  const { t } = useTranslation();
  const models = useAgentChatStore((s) => s.models);
  const modelsErrorCode = useAgentChatStore((s) => s.modelsErrorCode);
  const selectedModel = useAgentChatStore((s) => s.selectedModel);
  const setSelectedModel = useAgentChatStore((s) => s.setSelectedModel);

  if (modelsErrorCode !== null) {
    return (
      <span className="tn-chip" title={t('agent.model.label')}>
        {t('agent.model.unavailable', { code: modelsErrorCode })}
      </span>
    );
  }
  return (
    <label
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }}
      title={t('agent.model.note')}
    >
      {t('agent.model.label')}
      <select
        className="tn-input"
        style={{ width: 'auto', padding: '2px 6px' }}
        value={selectedModel ?? ''}
        onChange={(e) => setSelectedModel(e.target.value === '' ? null : e.target.value)}
      >
        <option value="">{t('agent.model.none')}</option>
        {(models ?? []).map((m) => (
          <option key={m.id} value={m.id}>
            {`${m.label} — ${t(`agent.model.source.${m.source}`, { defaultValue: m.source })}`}
          </option>
        ))}
      </select>
    </label>
  );
}

export function AgentChatPanel(): ReactElement {
  const { t } = useTranslation();
  const messages = useAgentChatStore((s) => s.messages);
  const truncated = useAgentChatStore((s) => s.truncated);
  const chips = useAgentChatStore((s) => s.chips);
  const draft = useAgentChatStore((s) => s.draft);
  const setDraft = useAgentChatStore((s) => s.setDraft);
  const send = useAgentChatStore((s) => s.send);
  const refreshStatus = useAgentChatStore((s) => s.refreshStatus);
  const loadModels = useAgentChatStore((s) => s.loadModels);
  const selectedModel = useAgentChatStore((s) => s.selectedModel);

  useEffect(() => {
    void refreshStatus();
    void loadModels(MODEL_REGISTRY_TOOL);
  }, [refreshStatus, loadModels]);

  // Chips render under the LAST message of their turn; turn-less leftovers
  // (e.g. chips arriving before any speech) collect at the end of the list.
  const lastIndexByTurn = new Map<string, number>();
  messages.forEach((m, i) => {
    if (m.turnId !== undefined) lastIndexByTurn.set(m.turnId, i);
  });
  const chipsAt = new Map<number, ActionChip[]>();
  const orphanChips: ActionChip[] = [];
  for (const chip of chips) {
    const idx = lastIndexByTurn.get(chip.turnId);
    if (idx === undefined) {
      orphanChips.push(chip);
    } else {
      chipsAt.set(idx, [...(chipsAt.get(idx) ?? []), chip]);
    }
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <StatusHeader />
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 8, display: 'grid', gap: 8 }}>
        {truncated ? (
          <div style={{ fontSize: 12, color: 'var(--tn-fg-faint)', textAlign: 'center' }}>
            {t('agent.chat.truncated')}
          </div>
        ) : null}
        {messages.length === 0 ? (
          <div style={{ color: 'var(--tn-fg-muted)', padding: 8 }}>{t('agent.chat.empty')}</div>
        ) : null}
        {messages.map((m, i) => (
          <MessageRow
            key={m.kind === 'user' ? m.localId : `${m.turnId}:${i}`}
            message={m}
            chips={chipsAt.get(i) ?? []}
          />
        ))}
        {orphanChips.length > 0 ? (
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {orphanChips.map((c) => (
              <PhaseChip key={c.proposalId} chip={c} />
            ))}
          </div>
        ) : null}
      </div>
      <div style={{ borderTop: '1px solid var(--tn-border)', padding: 8, display: 'grid', gap: 6 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <ModelSelector />
          {selectedModel !== null ? (
            // Honesty: the contracted chat body has no model field yet.
            <span style={{ fontSize: 11, color: 'var(--tn-fg-faint)' }}>
              {t('agent.model.note')}
            </span>
          ) : null}
        </div>
        <form
          style={{ display: 'flex', gap: 6 }}
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <input
            className="tn-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t('agent.chat.placeholder')}
            aria-label={t('agent.chat.placeholder')}
          />
          <button type="submit" className="tn-btn tn-btn--primary" disabled={draft.trim() === ''}>
            {t('composer.send')}
          </button>
        </form>
      </div>
    </div>
  );
}
