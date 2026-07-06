/**
 * Supervisor chat store — POST /api/agent/chat + the `agent.speech` /
 * `agent.state` / `agent.action` stream reduce (fed by src/stores/ingest.ts),
 * plus the /api/agent/status header and the dynamic model registry.
 *
 * Honesty contract:
 *  - A sent message is 'sending' until the server's 202; 202 means ACCEPTED
 *    (the turn runs async), never "answered".
 *  - `agent.speech` chunks are appended per turnId and the bubble stays in a
 *    streaming state until a `final:true` chunk arrives.
 *  - Brain availability comes straight from the status DTO — 'unverified' is
 *    rendered as its own chip, never as green.
 *  - Model selection is a UI preference only for now: the contracted chat body
 *    is `{text}` (strict), so the panel says the selection is not yet applied
 *    instead of pretending it is.
 */
import { create } from 'zustand';
import type {
  AgentActionPayload,
  AgentRuntimeState,
  AgentStatusDto,
  Envelope,
} from '@terminull/shared';
import { ApiHttpError, api } from '../api/client';
import type { ModelInfo } from '../api/types';

export type ChatSendState = 'sending' | 'accepted' | 'failed';

export interface UserChatMessage {
  kind: 'user';
  localId: string;
  text: string;
  state: ChatSendState;
  /** Set from the 202 body — pairs the message with the agent's turn. */
  turnId?: string;
  errorCode?: string;
  ts: number;
}

export interface AgentChatMessage {
  kind: 'agent';
  turnId: string;
  text: string;
  /** False while chunks are still streaming for this turn. */
  final: boolean;
  ts: number;
}

export type ChatMessage = UserChatMessage | AgentChatMessage;

/** Latest known audit phase of one proposal, rendered as an inline chip. */
export interface ActionChip {
  proposalId: string;
  turnId: string;
  actionKind: string;
  phase: AgentActionPayload['phase'];
  confirmationId?: string;
  resultCode?: string;
  ts: number;
}

interface AgentChatState {
  messages: ChatMessage[];
  /** True when old messages were dropped by the window cap. */
  truncated: boolean;
  chips: ActionChip[];
  /** Live runtime state from `agent.state` events (null until first event). */
  runtimeState: AgentRuntimeState | null;
  runtimeReason?: string;
  status: AgentStatusDto | null;
  statusErrorCode: string | null;
  models: ModelInfo[] | null;
  modelsErrorCode: string | null;
  selectedModel: string | null;
  draft: string;
  setDraft(text: string): void;
  setSelectedModel(id: string | null): void;
  send(): Promise<void>;
  refreshStatus(): Promise<void>;
  loadModels(toolId: string): Promise<void>;
  applyEvents(batch: Envelope[]): void;
}

export const MAX_CHAT_MESSAGES = 200;
const MAX_CHIPS = 100;
let nextLocal = 1;

function payloadOf(ev: Envelope): Record<string, unknown> {
  const p = ev.payload;
  return p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
}

function capMessages(messages: ChatMessage[]): { messages: ChatMessage[]; dropped: boolean } {
  if (messages.length <= MAX_CHAT_MESSAGES) return { messages, dropped: false };
  return { messages: messages.slice(messages.length - MAX_CHAT_MESSAGES), dropped: true };
}

export const useAgentChatStore = create<AgentChatState>((set, get) => ({
  messages: [],
  truncated: false,
  chips: [],
  runtimeState: null,
  status: null,
  statusErrorCode: null,
  models: null,
  modelsErrorCode: null,
  selectedModel: null,
  draft: '',

  setDraft: (draft) => set({ draft }),
  setSelectedModel: (selectedModel) => set({ selectedModel }),

  send: async () => {
    const text = get().draft.trim();
    if (text.length === 0) return;
    const localId = `m${nextLocal++}`;
    const entry: UserChatMessage = {
      kind: 'user',
      localId,
      text,
      state: 'sending',
      ts: Date.now(),
    };
    const capped = capMessages([...get().messages, entry]);
    set({
      draft: '',
      messages: capped.messages,
      truncated: get().truncated || capped.dropped,
    });
    const update = (patch: Partial<UserChatMessage>): void => {
      set({
        messages: get().messages.map((m) =>
          m.kind === 'user' && m.localId === localId ? { ...m, ...patch } : m,
        ),
      });
    };
    try {
      const res = await api.agentChat(text);
      // 202 = the turn was accepted and runs async; progress arrives on WS.
      update({ state: 'accepted', turnId: res.turnId });
    } catch (e) {
      const code = e instanceof ApiHttpError ? e.code : 'network';
      // Restore the draft so a failed send is one keystroke from retry.
      set({ draft: get().draft.length > 0 ? get().draft : text });
      update({ state: 'failed', errorCode: code });
    }
  },

  refreshStatus: async () => {
    try {
      const status = await api.agentStatus();
      set({ status, statusErrorCode: null });
    } catch (e) {
      const code = e instanceof ApiHttpError ? e.code : 'network';
      set({ statusErrorCode: code });
    }
  },

  loadModels: async (toolId) => {
    try {
      const res = await api.toolModels(toolId);
      set({ models: res.models, modelsErrorCode: null });
    } catch (e) {
      const code = e instanceof ApiHttpError ? e.code : 'network';
      set({ models: null, modelsErrorCode: code });
    }
  },

  applyEvents: (batch) => {
    const { truncated } = get();
    let { messages, chips, runtimeState, runtimeReason } = get();
    let changed = false;
    for (const ev of batch) {
      const payload = payloadOf(ev);
      switch (ev.type) {
        case 'agent.speech': {
          const turnId = payload['turnId'];
          const text = payload['text'];
          if (typeof turnId !== 'string' || typeof text !== 'string') break;
          const final = payload['final'] === true;
          // Chunks append to this turn's open bubble; a chunk after final
          // starts a fresh bubble instead of silently rewriting history.
          const idx = messages.findIndex(
            (m) => m.kind === 'agent' && m.turnId === turnId && !m.final,
          );
          if (idx >= 0) {
            const existing = messages[idx] as AgentChatMessage;
            messages = [
              ...messages.slice(0, idx),
              { ...existing, text: existing.text + text, final },
              ...messages.slice(idx + 1),
            ];
          } else {
            messages = [...messages, { kind: 'agent', turnId, text, final, ts: ev.ts }];
          }
          changed = true;
          break;
        }
        case 'agent.state': {
          const state = payload['state'];
          if (typeof state !== 'string') break;
          runtimeState = state as AgentRuntimeState;
          runtimeReason =
            typeof payload['reason'] === 'string' ? (payload['reason'] as string) : undefined;
          changed = true;
          break;
        }
        case 'agent.action': {
          const p = payload as Partial<AgentActionPayload>;
          if (
            typeof p.phase !== 'string' ||
            typeof p.proposalId !== 'string' ||
            typeof p.turnId !== 'string'
          ) {
            break;
          }
          const chip: ActionChip = {
            proposalId: p.proposalId,
            turnId: p.turnId,
            actionKind: typeof p.actionKind === 'string' ? p.actionKind : '',
            phase: p.phase as AgentActionPayload['phase'],
            ...(typeof p.confirmationId === 'string' ? { confirmationId: p.confirmationId } : {}),
            ...(typeof p.resultCode === 'string' ? { resultCode: p.resultCode } : {}),
            ts: ev.ts,
          };
          // One chip per proposal showing its LATEST phase (the full chain
          // lives in the inbox card's audit trail).
          const existing = chips.findIndex((c) => c.proposalId === chip.proposalId);
          if (existing >= 0) {
            chips = [...chips.slice(0, existing), chip, ...chips.slice(existing + 1)];
          } else {
            chips = [...chips, chip].slice(-MAX_CHIPS);
          }
          changed = true;
          break;
        }
        default:
          break;
      }
    }
    if (!changed) return;
    const capped = capMessages(messages);
    set({
      messages: capped.messages,
      truncated: truncated || capped.dropped,
      chips,
      runtimeState,
      ...(runtimeReason !== undefined ? { runtimeReason } : { runtimeReason: undefined }),
    });
  },
}));
