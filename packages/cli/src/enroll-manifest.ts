/**
 * Enroll manifest — the EXACT remote footprint of `terminull enroll <host>`.
 *
 * Everything the enroller installs lives under ONE dedicated directory in the
 * remote $HOME ({@link AGENT_DIR}); nothing else on the remote is touched (no
 * rc files, no crontabs, no launchd/systemd units, no PATH edits). That makes
 * `terminull enroll --remove <host>` a COMPLETE reversal: best-effort daemon
 * kill (via {@link HOST_PID_FILE}) + `rm -rf ~/<AGENT_DIR>` + dropping the
 * machine entry from the local machines.json. The only side effect we do not
 * own is ssh's own known_hosts bookkeeping.
 *
 * Layout under `~/<AGENT_DIR>/`:
 *   VERSION            — bundle version + install stamp; written LAST
 *                        (write-then-rename), so its presence == complete
 *                        install and re-running enroll is an in-place upgrade.
 *   node-path          — pinned ABSOLUTE realpath of the remote node (>= 22).
 *   bin/terminull-agent — sh launcher: exec "$(cat node-path)" pkg/dist/bin.js
 *                        agent --state-dir <abs>/host "$@"  (absolute paths
 *                        baked at enroll time; the remote PATH is NEVER used
 *                        at runtime — ~/.local/bin/node shadowing trap).
 *   pkg/               — the agent bundle (session-host dist + prod deps).
 *   host/              — paneld state dir (host.sock, host-token, host-id,
 *                        host.pid, paneld.log). Socket path length is
 *                        validated against the AF_UNIX cap before binding.
 */

/** Dedicated remote dir, relative to the remote $HOME. */
export const AGENT_DIR = '.terminull-agent';

/** Files/dirs inside {@link AGENT_DIR} (complete list — the removal contract). */
export const AGENT_DIR_ENTRIES = ['VERSION', 'node-path', 'bin', 'pkg', 'host'] as const;

/** Launcher path relative to the remote $HOME (== DEFAULT_REMOTE_AGENT_CMD). */
export const AGENT_LAUNCHER = `${AGENT_DIR}/bin/terminull-agent`;

/** paneld state dir relative to the remote $HOME. */
export const AGENT_HOST_DIR = `${AGENT_DIR}/host`;

/** Daemon pid file inside the state dir (written by paneld; used by --remove). */
export const HOST_PID_FILE = 'host.pid';

/** Minimum remote node major version enroll accepts. */
export const MIN_REMOTE_NODE_MAJOR = 22;

/**
 * Node resolution candidates probed IN ORDER on the remote when `--node` is
 * not given. Each must pass `<candidate> --version` >= {@link MIN_REMOTE_NODE_MAJOR};
 * the first hit is pinned by absolute realpath. `command -v node` runs first
 * (the user's non-interactive PATH), the fixed paths cover login-PATH-only
 * installs; `~/.local/bin/node` is probed LAST because it is the classic
 * shadow of a newer system node.
 */
export const REMOTE_NODE_CANDIDATES = [
  'command -v node',
  '/opt/homebrew/bin/node',
  '/usr/local/bin/node',
  '/usr/bin/node',
  '~/.local/bin/node',
] as const;
