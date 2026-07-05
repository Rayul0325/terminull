import { SHARED_PLACEHOLDER, type TerminullMeta } from '@terminull/shared';

/** Core-layer metadata, extending the shared contract. */
export interface CoreInfo extends TerminullMeta {
  readonly kind: 'core';
}

/** Typed placeholder wiring the shared package into core. */
export const CORE_PLACEHOLDER: CoreInfo = {
  ...SHARED_PLACEHOLDER,
  name: '@terminull/core',
  kind: 'core',
};
