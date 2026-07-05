/**
 * Minimal tmux adoption helpers.
 *
 * paneld can "adopt" an externally-running tmux session: it spawns a PTY that
 * runs `tmux attach -t <target>` and treats it as a read-write session flagged
 * `owned:false`. This lets a panel view/drive a terminal it did not spawn.
 *
 * The binary is resolved explicitly (`$HOME/.local/bin/tmux` first, then PATH)
 * because on this machine tmux is a source build under `~/.local/bin` and must
 * not be shadowed by a different PATH entry.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const pexec = promisify(execFile);

/** Search PATH for an executable, returning its absolute path or null. */
function which(bin: string): string | null {
  const dirs = (process.env.PATH ?? '').split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const full = path.join(dir, bin);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      return full;
    } catch {
      /* not executable here */
    }
  }
  return null;
}

/**
 * Resolve the tmux binary: the source build under `~/.local/bin` wins, then
 * anything on PATH. Returns null when tmux is not installed (callers guard).
 */
export function resolveTmuxBin(): string | null {
  const local = path.join(os.homedir(), '.local/bin/tmux');
  try {
    fs.accessSync(local, fs.constants.X_OK);
    return local;
  } catch {
    /* fall through to PATH */
  }
  return which('tmux');
}

/** True when `target` is a live tmux session on the given tmux server. */
export async function hasSession(bin: string, target: string): Promise<boolean> {
  try {
    await pexec(bin, ['has-session', '-t', target]);
    return true;
  } catch {
    return false;
  }
}

/** The argv for a PTY that attaches to an existing tmux session. */
export function attachArgs(target: string): string[] {
  return ['attach', '-t', target];
}

/**
 * Inject a literal directive line into a tmux target, then submit.
 *
 * A leading `C-u` clears any half-typed draft sitting in the target's input box
 * first — without it the injected text gets GLUED onto the leftover draft and
 * both submit as one mangled line. (Port of the control-tower tmux draft-clear
 * quirk, live-reproduced 2026-07-06.)
 */
export async function sendText(bin: string, target: string, text: string): Promise<void> {
  await pexec(bin, ['send-keys', '-t', target, 'C-u']);
  await pexec(bin, ['send-keys', '-t', target, '-l', text]);
  await pexec(bin, ['send-keys', '-t', target, 'Enter']);
}

/** Snapshot of a tmux pane's visible text (for verification/tests). */
export async function capturePane(bin: string, target: string): Promise<string> {
  const { stdout } = await pexec(bin, ['capture-pane', '-t', target, '-p']);
  return stdout;
}
