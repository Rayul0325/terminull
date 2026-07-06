/**
 * Layout-template store — dockview `toJSON()` snapshots, persisted to
 * IndexedDB (idb-keyval), plus a per-project default-template map.
 *
 * Built-in templates are NOT stored here: they are programmatic builders
 * (workspace/builtinLayouts.ts) referenced by reserved ids, so they can adapt
 * to whatever sessions exist. Saved templates carry a schema `version` for
 * future migration.
 *
 * Server sync: the cross-device channel is a REAL follow-up, not a fake —
 * {@link layoutSync} says so explicitly and the settings UI shows the honest
 * "device-local only" state until the server endpoint exists.
 */
import { create } from 'zustand';
import { del, get as idbGet, set as idbSet } from 'idb-keyval';

export const BUILTIN_TEMPLATE_IDS = ['chat', 'ide', 'ops', 'preview'] as const;
export type BuiltinTemplateId = (typeof BUILTIN_TEMPLATE_IDS)[number];

export interface SavedTemplate {
  name: string;
  version: 1;
  savedAt: number;
  /** dockview SerializedDockview (opaque here). */
  layout: unknown;
}

/** Cross-device sync backend contract (server endpoint pending). */
export interface LayoutSyncBackend {
  readonly enabled: boolean;
  /** Machine reason code while disabled. */
  readonly reasonCode: string;
}

export const layoutSync: LayoutSyncBackend = {
  enabled: false,
  reasonCode: 'server_endpoint_pending',
};

const IDB_TEMPLATES = 'terminull.layout.templates';
const IDB_DEFAULTS = 'terminull.layout.defaults';
const IDB_LAST_PREFIX = 'terminull.layout.last.';

interface LayoutState {
  loaded: boolean;
  templates: Record<string, SavedTemplate>;
  /** projectId (or '*' for global) → template id (builtin or saved name). */
  defaults: Record<string, string>;
  load(): Promise<void>;
  saveTemplate(name: string, layout: unknown): Promise<void>;
  deleteTemplate(name: string): Promise<void>;
  setDefault(projectId: string, templateId: string | null): Promise<void>;
  /** Resolve the default template id for a project (project → global → none). */
  defaultFor(projectId: string): string | undefined;
}

export const useLayoutStore = create<LayoutState>((set, get) => ({
  loaded: false,
  templates: {},
  defaults: {},

  load: async () => {
    if (get().loaded) return;
    try {
      const [templates, defaults] = await Promise.all([
        idbGet<Record<string, SavedTemplate>>(IDB_TEMPLATES),
        idbGet<Record<string, string>>(IDB_DEFAULTS),
      ]);
      set({ loaded: true, templates: templates ?? {}, defaults: defaults ?? {} });
    } catch {
      // IndexedDB unavailable (private mode etc.) — run memory-only, honestly
      // losing persistence rather than crashing the workspace.
      set({ loaded: true });
    }
  },

  saveTemplate: async (name, layout) => {
    const templates = {
      ...get().templates,
      [name]: { name, version: 1 as const, savedAt: Date.now(), layout },
    };
    set({ templates });
    try {
      await idbSet(IDB_TEMPLATES, templates);
    } catch {
      /* persistence unavailable — state already updated in memory */
    }
  },

  deleteTemplate: async (name) => {
    const templates = { ...get().templates };
    delete templates[name];
    // A default pointing at the deleted template would dangle — clean it up.
    const defaults = Object.fromEntries(
      Object.entries(get().defaults).filter(([, v]) => v !== name),
    );
    set({ templates, defaults });
    try {
      await Promise.all([idbSet(IDB_TEMPLATES, templates), idbSet(IDB_DEFAULTS, defaults)]);
    } catch {
      /* persistence unavailable */
    }
  },

  setDefault: async (projectId, templateId) => {
    const defaults = { ...get().defaults };
    if (templateId === null) delete defaults[projectId];
    else defaults[projectId] = templateId;
    set({ defaults });
    try {
      await idbSet(IDB_DEFAULTS, defaults);
    } catch {
      /* persistence unavailable */
    }
  },

  defaultFor: (projectId) => {
    const { defaults } = get();
    return defaults[projectId] ?? defaults['*'];
  },
}));

/** Persist the last-used layout for a project (auto-restore path). */
export async function saveLastLayout(projectId: string, layout: unknown): Promise<void> {
  try {
    await idbSet(IDB_LAST_PREFIX + projectId, layout);
  } catch {
    /* persistence unavailable */
  }
}

/** Load the last-used layout for a project, or undefined. */
export async function loadLastLayout(projectId: string): Promise<unknown> {
  try {
    return await idbGet(IDB_LAST_PREFIX + projectId);
  } catch {
    return undefined;
  }
}

/** Drop a saved last-layout (used when it fails to restore). */
export async function clearLastLayout(projectId: string): Promise<void> {
  try {
    await del(IDB_LAST_PREFIX + projectId);
  } catch {
    /* persistence unavailable */
  }
}
