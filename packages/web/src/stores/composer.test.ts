/**
 * Composer optimistic-state tests: nothing turns green before the server
 * confirms; queued/pending/failed are all distinct honest states; a failed
 * send restores the draft.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { setFetchImpl } from '../api/client';
import { useComposerStore } from './composer';

let restoreFetch: (() => void) | null = null;

afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
  useComposerStore.setState({ drafts: {}, pending: [] });
});

function respond(status: number, body: unknown): void {
  restoreFetch = setFetchImpl(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
}

describe('composer send', () => {
  it('delivered only after the server says so', async () => {
    respond(200, { delivered: true, directiveId: 'd-1' });
    const store = useComposerStore.getState();
    store.setDraft('s1', 'do the thing');
    await store.send('s1');
    const pending = useComposerStore.getState().pending;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ state: 'delivered', directiveId: 'd-1' });
    expect(useComposerStore.getState().drafts['s1']).toBe('');
  });

  it('202 queued stays queued, never delivered', async () => {
    respond(202, { queued: true, directiveId: 'd-2' });
    const store = useComposerStore.getState();
    store.setDraft('s1', 'later please');
    await store.send('s1');
    expect(useComposerStore.getState().pending[0]).toMatchObject({ state: 'queued' });
  });

  it('a permission park becomes pending_confirmation with the id', async () => {
    respond(202, { code: 'pending_confirmation', confirmationId: 'c-9', action: 'directive.send' });
    const store = useComposerStore.getState();
    store.setDraft('s1', 'needs approval');
    await store.send('s1');
    expect(useComposerStore.getState().pending[0]).toMatchObject({
      state: 'pending_confirmation',
      confirmationId: 'c-9',
    });
  });

  it('failure keeps the state red and restores the draft for retry', async () => {
    respond(403, { code: 'forbidden', action: 'directive.send' });
    const store = useComposerStore.getState();
    store.setDraft('s1', 'blocked text');
    await store.send('s1');
    expect(useComposerStore.getState().pending[0]).toMatchObject({
      state: 'failed',
      errorCode: 'forbidden',
    });
    expect(useComposerStore.getState().drafts['s1']).toBe('blocked text');
  });

  it('empty drafts are not sent', async () => {
    respond(200, { delivered: true });
    const store = useComposerStore.getState();
    store.setDraft('s1', '   ');
    await store.send('s1');
    expect(useComposerStore.getState().pending).toHaveLength(0);
  });
});
