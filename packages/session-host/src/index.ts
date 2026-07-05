import type { TerminullMeta } from '@terminull/shared';

/**
 * Placeholder for the PTY-backed session host.
 *
 * `node-pty` is declared as a dependency for a later milestone but is
 * intentionally NOT imported here yet, so installs stay light and no native
 * build is required to compile this package.
 */
export interface SessionHostInfo extends TerminullMeta {
  readonly ptyBackend: 'node-pty';
  readonly wired: boolean;
}

export const SESSION_HOST_PLACEHOLDER: SessionHostInfo = {
  name: '@terminull/session-host',
  version: '0.0.0',
  ptyBackend: 'node-pty',
  wired: false,
};
