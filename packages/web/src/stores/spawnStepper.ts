/**
 * Session-create stepper state (M6 debt, M9 W5). A single-column wizard:
 * tool → machine → cwd → model → permission mode → confirm. The spawn POST
 * uses ONLY contracted fields (`adapterId`, `cwd`, `model?`,
 * `permissionMode?`, `machine?` — `machine` omitted for local, `profile`
 * omitted so the server applies the ACTIVE profile, which the confirm step
 * badges honestly).
 *
 * Capability honesty: models come from the dynamic per-tool registry; a 422
 * `adapter_unsupported` is the NORMAL "this tool has no model discovery"
 * state (the step says so and spawns with the tool default), never an empty
 * dropdown pretending to be a choice. Permission modes come from the
 * adapter's declared `capabilities.permissionModes`; an empty list skips the
 * choice honestly.
 */
import { create } from 'zustand';
import type { MachineStateDto, ModelInfo } from '../api/types';
import { ApiHttpError, api } from '../api/client';
import type { SpawnResponse } from '../api/types';

export const STEPS = ['tool', 'machine', 'cwd', 'model', 'permission', 'confirm'] as const;
export type StepId = (typeof STEPS)[number];

/** Machines eligible for a spawn: local plus CONNECTED remotes only. */
export function selectableMachines(machines: Record<string, MachineStateDto>): string[] {
  const remote = Object.values(machines)
    .filter((m) => m.id !== 'local' && m.state === 'connected')
    .map((m) => m.id)
    .sort();
  return ['local', ...remote];
}

interface SpawnStepperState {
  open: boolean;
  step: StepId;
  toolId: string | null;
  machine: string;
  cwd: string;
  /** null = the tool's default model (no field sent). */
  model: string | null;
  /** null = the tool's default mode (no field sent). */
  permissionMode: string | null;
  models: ModelInfo[] | null;
  /** null = not asked yet; false = 422 adapter_unsupported (honest skip). */
  modelsSupported: boolean | null;
  modelsErrorCode: string | null;
  spawning: boolean;
  spawnErrorCode: string | null;
  created: SpawnResponse | null;
  openStepper(): void;
  close(): void;
  setStep(step: StepId): void;
  selectTool(toolId: string): void;
  setMachine(machine: string): void;
  setCwd(cwd: string): void;
  setModel(model: string | null): void;
  setPermissionMode(mode: string | null): void;
  /** POST /api/sessions with the contracted fields. */
  spawn(): Promise<void>;
}

const INITIAL = {
  step: 'tool' as StepId,
  toolId: null,
  machine: 'local',
  cwd: '',
  model: null,
  permissionMode: null,
  models: null,
  modelsSupported: null,
  modelsErrorCode: null,
  spawning: false,
  spawnErrorCode: null,
  created: null,
};

export const useSpawnStepperStore = create<SpawnStepperState>((set, get) => ({
  open: false,
  ...INITIAL,

  openStepper: () => set({ open: true, ...INITIAL }),
  close: () => set({ open: false }),
  setStep: (step) => set({ step }),

  selectTool: (toolId) => {
    // A tool change invalidates the downstream choices.
    set({
      toolId,
      model: null,
      permissionMode: null,
      models: null,
      modelsSupported: null,
      modelsErrorCode: null,
    });
    void (async () => {
      try {
        const res = await api.toolModels(toolId);
        // Ignore a late response for a tool the user moved away from.
        if (get().toolId !== toolId) return;
        set({ models: res.models, modelsSupported: true });
      } catch (e) {
        if (get().toolId !== toolId) return;
        if (e instanceof ApiHttpError && e.status === 422) {
          // Honest: no model discovery — the spawn uses the tool default.
          set({ models: null, modelsSupported: false, modelsErrorCode: e.code });
          return;
        }
        const code = e instanceof ApiHttpError ? e.code : 'network';
        set({ modelsErrorCode: code });
      }
    })();
  },

  setMachine: (machine) => set({ machine }),
  setCwd: (cwd) => set({ cwd }),
  setModel: (model) => set({ model }),
  setPermissionMode: (permissionMode) => set({ permissionMode }),

  spawn: async () => {
    const s = get();
    if (s.toolId === null || s.cwd.trim() === '' || s.spawning) return;
    set({ spawning: true, spawnErrorCode: null });
    try {
      const created = await api.spawnSession({
        adapterId: s.toolId,
        cwd: s.cwd.trim(),
        ...(s.model !== null ? { model: s.model } : {}),
        ...(s.permissionMode !== null ? { permissionMode: s.permissionMode } : {}),
        ...(s.machine !== 'local' ? { machine: s.machine } : {}),
      });
      set({ spawning: false, created });
    } catch (e) {
      const code = e instanceof ApiHttpError ? e.code : 'network';
      set({ spawning: false, spawnErrorCode: code });
    }
  },
}));
