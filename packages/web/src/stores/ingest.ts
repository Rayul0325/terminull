/**
 * The single wiring point between the WS event stream and the zustand stores.
 * Runs OUTSIDE React (started once from main.tsx): store updates happen via
 * `setState` on batched frames, so a burst of server events costs one render.
 */
import { EventStream } from '../api/stream';
import { api } from '../api/client';
import { useAgentChatStore } from './agentChat';
import { useApprovalsStore } from './approvals';
import { useConnectionStore } from './connection';
import { useFleetStore } from './fleet';

let stream: EventStream | null = null;

/** Start the global ingest loop (idempotent). Returns the stream for tests. */
export function startIngest(): EventStream {
  if (stream) return stream;
  stream = new EventStream({
    handlers: {
      onStatus: (status) => {
        useConnectionStore.getState().setWsStatus(status);
      },
      onEvents: (batch) => {
        useConnectionStore.getState().applyEvents(batch);
        useFleetStore.getState().applyEvents(batch);
        useApprovalsStore.getState().applyEvents(batch);
        useAgentChatStore.getState().applyEvents(batch);
      },
      onGap: () => {
        // Stream history was lost — snapshot stores refetch from REST.
        void useFleetStore.getState().refresh();
        void useApprovalsStore.getState().refresh();
      },
    },
  });
  stream.start();
  // Seed host state from health once; afterwards host.up/down events keep it
  // current. A failure leaves hostConnected=null → the UI shows "확인 중".
  void api
    .health()
    .then((h) => {
      useConnectionStore.getState().setHostConnected(h.host.connected);
    })
    .catch(() => {
      /* stays null (unknown) — honest */
    });
  void useFleetStore.getState().refresh();
  return stream;
}

/** Stop the global ingest loop (tests / teardown). */
export function stopIngest(): void {
  stream?.stop();
  stream = null;
}
