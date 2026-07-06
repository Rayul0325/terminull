import type { TerminullMeta } from '@terminull/shared';

export * from './bundle.js';
export * from './cli.js';
export * from './enroll-manifest.js';
export * from './enroll.js';
export * from './machines-file.js';
export * from './messages.js';
export * from './server-api.js';
export * from './ssh-runner.js';
export * from './status.js';

/** Typed placeholder identity for the CLI package. */
export const CLI_PLACEHOLDER: TerminullMeta = {
  name: '@terminull/cli',
  version: '0.0.0',
};
