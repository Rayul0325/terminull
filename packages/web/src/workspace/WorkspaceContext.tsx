/**
 * Workspace actions exposed to panels and renderers (terminal jump, opening
 * panels). Provided by DockWorkspace; null outside a workspace so consumers
 * degrade honestly (e.g. BashCard hides its terminal-jump button).
 */
import { createContext, useContext } from 'react';

export interface WorkspaceActions {
  openSessionPanel(sessionId: string, adapterId: string): void;
  openTerminalPanel(sessionId: string, mode: 'rw' | 'ro'): void;
  /** Pop the active group out into a child window. */
  popoutActive(): void;
}

export const WorkspaceContext = createContext<WorkspaceActions | null>(null);

export function useWorkspace(): WorkspaceActions | null {
  return useContext(WorkspaceContext);
}
