/**
 * `terminull machines [status]` — registry + live connection states.
 *
 * Live states come from the running server (`GET /api/machines`, loopback);
 * when no server runs (or it predates the machines API) the CLI falls back to
 * machines.json and says so honestly — config entries are never dressed up as
 * live connection states.
 */
import type { MachineConfig, MachineStateDto } from '@terminull/shared';
import { loadMachinesFile } from './machines-file.js';
import { fetchMachines } from './server-api.js';

export type MachinesStatus =
  | { source: 'server'; port: number; machines: MachineStateDto[] }
  | {
      source: 'config';
      reason: 'server_down' | 'no_machines_api' | 'bad_response';
      detail?: string;
      machines: MachineConfig[];
    };

/** Resolve live-or-config machine status for a server state dir. */
export async function machinesStatus(
  serverState: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MachinesStatus> {
  const live = await fetchMachines(serverState, fetchImpl);
  if (live.ok) return { source: 'server', port: live.port, machines: live.machines };
  return {
    source: 'config',
    reason: live.reason,
    detail: live.detail,
    machines: loadMachinesFile(serverState),
  };
}

/** Render one status table row set as plain terminal lines. */
export function renderStatusLines(status: MachinesStatus): string[] {
  const lines: string[] = [];
  if (status.source === 'server') {
    const header = ['ID', '이름', '상태', '마지막 응답'];
    const rows = status.machines.map((m) => [
      m.id,
      m.label,
      stateLabel(m.state),
      m.lastSeenAt === null ? '-' : new Date(m.lastSeenAt).toLocaleString(),
    ]);
    lines.push(...table([header, ...rows]));
  } else {
    const header = ['ID', '이름', '전송', '상태'];
    const rows = status.machines.map((m) => [
      m.id,
      m.label,
      m.transport.kind === 'ssh' ? `ssh ${m.transport.host}` : m.transport.kind,
      m.enabled ? '설정만 (실시간 아님)' : '비활성 (설정)',
    ]);
    lines.push(...table([header, ...rows]));
  }
  return lines;
}

function stateLabel(state: MachineStateDto['state']): string {
  switch (state) {
    case 'connected':
      return '연결됨';
    case 'connecting':
      return '연결 중';
    case 'stale':
      return '응답 없음';
    case 'disabled':
      return '비활성';
  }
}

function table(rows: string[][]): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows.map((row) =>
    row
      .map((cell, i) => cell.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd(),
  );
}
