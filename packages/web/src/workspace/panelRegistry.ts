/**
 * Panel-type registry — the workspace-side seam the plugin system's `panels`
 * contribution point will plug into (same pattern as the renderer registry:
 * built-ins register through the exact door third parties will use).
 *
 * A panel type = a dockview component id + a React component + an i18n title.
 * `dockviewComponents()` materializes the map DockviewReact consumes; the
 * placeholder wrapper guarantees an unknown panel id (stale layout, missing
 * plugin) renders an HONEST "unavailable" panel instead of crashing dockview.
 */
import type { FunctionComponent } from 'react';
import type { IDockviewPanelProps } from 'dockview';

export interface PanelTypeDef {
  /** Stable panel-type id ('session', 'terminal', 'fleet', 'placeholder'). */
  id: string;
  /** i18n key for the default tab title. */
  titleKey: string;
  Component: FunctionComponent<IDockviewPanelProps>;
}

/** Params contracts for the built-in panel types. */
export interface SessionPanelParams {
  sessionId: string;
  adapterId: string;
  [index: string]: unknown;
}
export interface TerminalPanelParams {
  sessionId: string;
  mode: 'rw' | 'ro';
  [index: string]: unknown;
}
export interface PlaceholderPanelParams {
  /** Which future panel kind this placeholder stands in for. */
  panelKind: string;
  [index: string]: unknown;
}

const types = new Map<string, PanelTypeDef>();

export function registerPanelType(def: PanelTypeDef): void {
  if (types.has(def.id)) throw new Error(`panel type already registered: ${def.id}`);
  types.set(def.id, def);
}

export function getPanelType(id: string): PanelTypeDef | undefined {
  return types.get(id);
}

export function listPanelTypes(): PanelTypeDef[] {
  return [...types.values()];
}

/** The components map handed to DockviewReact. */
export function dockviewComponents(): Record<string, FunctionComponent<IDockviewPanelProps>> {
  const out: Record<string, FunctionComponent<IDockviewPanelProps>> = {};
  for (const [id, def] of types) out[id] = def.Component;
  return out;
}
