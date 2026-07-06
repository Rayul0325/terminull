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
import { useMachinesStore } from './machines';
import { usePrefsStore } from './prefs';
import { useSessionStatusStore } from './sessionStatus';

/** Seed pending confirmations from REST (M9 W7 — survives a reload). */
function seedConfirmations(): void {
  void api
    .confirmations()
    .then((res) => useConnectionStore.getState().seedConfirmations(res.pending))
    .catch(() => {
      /* stream events still populate the list — no fake entries on failure */
    });
}

let stream: EventStream | null = null;
let unsubscribeFleetSeed: (() => void) | null = null;

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
        useMachinesStore.getState().applyEvents(batch);
        useApprovalsStore.getState().applyEvents(batch);
        useAgentChatStore.getState().applyEvents(batch);
        useSessionStatusStore.getState().applyEvents(batch);
      },
      onGap: () => {
        // Stream history was lost — snapshot stores refetch from REST.
        void useFleetStore.getState().refresh();
        void useApprovalsStore.getState().refresh();
        seedConfirmations();
      },
    },
  });
  stream.start();
  // The fleet snapshot carries `machines[]` — mirror it into the machine store
  // whenever a new snapshot lands (REST authoritative, WS events in between).
  unsubscribeFleetSeed = useFleetStore.subscribe((state, prev) => {
    if (state.snapshot !== prev.snapshot) {
      useMachinesStore.getState().seedFromFleet(state.snapshot?.machines);
    }
  });
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
  // Pending confirmations survive a reload via the REST seed (M9 W7), and the
  // server-roamed keybinding overrides seed the prefs store (D6 merge order).
  seedConfirmations();
  void usePrefsStore.getState().loadServerKeybinds();
  return stream;
}

/** Stop the global ingest loop (tests / teardown). */
export function stopIngest(): void {
  stream?.stop();
  stream = null;
  unsubscribeFleetSeed?.();
  unsubscribeFleetSeed = null;
}
