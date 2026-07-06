/**
 * Guided-form registry for the harness editor (M9 W2). The contract mandates
 * a guided/raw toggle ONLY for files whose contract specifies a guided form —
 * the M9 contract specifies none, so this registry ships EMPTY and the editor
 * renders raw-only (the honest state; a fake form would imply validation the
 * pipeline does not perform). A future contract adds entries here and the
 * toggle appears without editor changes.
 */
import type { FunctionComponent } from 'react';

export interface GuidedFormProps {
  fileId: string;
  /** Current raw buffer. */
  draft: string;
  /** Replace the raw buffer (the form is a VIEW over the same content). */
  onChange(next: string): void;
}

/** fileId → guided form component. Empty in v1 (see module doc). */
export const GUIDED_FORMS: Record<string, FunctionComponent<GuidedFormProps>> = {};

export function guidedFormFor(fileId: string): FunctionComponent<GuidedFormProps> | undefined {
  return GUIDED_FORMS[fileId];
}
