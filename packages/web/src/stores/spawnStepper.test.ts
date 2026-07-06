/**
 * Spawn-stepper store tests (M9 W5 / gate oracle g, UI half). The POST body
 * must carry EXACTLY the contracted fields: machine+model+permissionMode ride
 * along when chosen, `machine` is omitted for local, defaults are omitted
 * (never sent as empty strings), and a failed spawn surfaces the machine
 * code. Model discovery honesty: a 422 is the normal "no discovery" state.
 * All fetches mocked; no real CLI spawns anywhere.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { MachineStateDto } from '../api/types';
import { setFetchImpl } from '../api/client';
import { STEPS, selectableMachines, useSpawnStepperStore } from './spawnStepper';

let restoreFetch: (() => void) | null = null;

afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
  useSpawnStepperStore.getState().openStepper();
  useSpawnStepperStore.setState({ open: false });
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('selectableMachines', () => {
  it('offers local plus CONNECTED remotes only', () => {
    const machines: Record<string, MachineStateDto> = {
      mars: { id: 'mars', label: 'Mars', state: 'connected', lastSeenAt: 1 },
      pluto: { id: 'pluto', label: 'Pluto', state: 'stale', lastSeenAt: 1 },
      venus: { id: 'venus', label: 'Venus', state: 'connecting', lastSeenAt: null },
    };
    expect(selectableMachines(machines)).toEqual(['local', 'mars']);
  });
});

describe('spawn body (oracle g)', () => {
  it('POSTs machine + model + permissionMode + cwd when all are chosen', async () => {
    const posts: Array<[string, unknown]> = [];
    restoreFetch = setFetchImpl((url, init) => {
      posts.push([url, JSON.parse(String(init?.body))]);
      return Promise.resolve(json(201, { sessionId: 'srv-1', sid: 1, pid: 42, label: 'w' }));
    });
    const s = useSpawnStepperStore.getState();
    s.openStepper();
    useSpawnStepperStore.setState({ toolId: 'claude' }); // skip the model fetch
    s.setMachine('mars');
    s.setCwd('/w/proj');
    s.setModel('claude-opus-4-8');
    s.setPermissionMode('plan');
    await useSpawnStepperStore.getState().spawn();
    expect(posts).toEqual([
      [
        '/api/sessions',
        {
          adapterId: 'claude',
          cwd: '/w/proj',
          model: 'claude-opus-4-8',
          permissionMode: 'plan',
          machine: 'mars',
        },
      ],
    ]);
    expect(useSpawnStepperStore.getState().created?.sessionId).toBe('srv-1');
  });

  it('omits machine for local and omits unchosen defaults entirely', async () => {
    const bodies: unknown[] = [];
    restoreFetch = setFetchImpl((_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Promise.resolve(json(201, { sessionId: 'srv-2', sid: 2, pid: 43, label: 'x' }));
    });
    const s = useSpawnStepperStore.getState();
    s.openStepper();
    useSpawnStepperStore.setState({ toolId: 'codex' });
    s.setCwd('/w/other');
    await useSpawnStepperStore.getState().spawn();
    expect(bodies).toEqual([{ adapterId: 'codex', cwd: '/w/other' }]);
  });

  it('a failed spawn keeps the honest machine code; nothing is created', async () => {
    restoreFetch = setFetchImpl(() => Promise.resolve(json(422, { code: 'machine_unavailable' })));
    const s = useSpawnStepperStore.getState();
    s.openStepper();
    useSpawnStepperStore.setState({ toolId: 'claude' });
    s.setCwd('/w/proj');
    s.setMachine('mars');
    await useSpawnStepperStore.getState().spawn();
    expect(useSpawnStepperStore.getState().spawnErrorCode).toBe('machine_unavailable');
    expect(useSpawnStepperStore.getState().created).toBeNull();
  });
});

describe('model discovery honesty', () => {
  it('selectTool loads the dynamic model list', async () => {
    restoreFetch = setFetchImpl(() =>
      Promise.resolve(json(200, { models: [{ id: 'opus', label: 'Opus', source: 'discovered' }] })),
    );
    useSpawnStepperStore.getState().openStepper();
    useSpawnStepperStore.getState().selectTool('claude');
    await new Promise((r) => setTimeout(r, 0));
    expect(useSpawnStepperStore.getState().modelsSupported).toBe(true);
    expect(useSpawnStepperStore.getState().models).toEqual([
      { id: 'opus', label: 'Opus', source: 'discovered' },
    ]);
  });

  it('a 422 adapter_unsupported is the honest "no discovery" state', async () => {
    restoreFetch = setFetchImpl(() =>
      Promise.resolve(json(422, { code: 'adapter_unsupported', operation: 'models' })),
    );
    useSpawnStepperStore.getState().openStepper();
    useSpawnStepperStore.getState().selectTool('generic-pty');
    await new Promise((r) => setTimeout(r, 0));
    expect(useSpawnStepperStore.getState().modelsSupported).toBe(false);
    expect(useSpawnStepperStore.getState().models).toBeNull();
  });

  it('changing the tool resets downstream model/permission choices', () => {
    restoreFetch = setFetchImpl(() => Promise.resolve(json(200, { models: [] })));
    const s = useSpawnStepperStore.getState();
    s.openStepper();
    useSpawnStepperStore.setState({ toolId: 'claude', model: 'opus', permissionMode: 'plan' });
    s.selectTool('codex');
    expect(useSpawnStepperStore.getState().model).toBeNull();
    expect(useSpawnStepperStore.getState().permissionMode).toBeNull();
  });

  it('step order is the contracted single-column sequence', () => {
    expect(STEPS).toEqual(['tool', 'machine', 'cwd', 'model', 'permission', 'confirm']);
  });
});
