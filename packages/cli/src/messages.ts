/**
 * CLI message catalog — Korean-first user-facing strings.
 *
 * There was no CLI-side locale mechanism in the repo (LocalizedText/i18n exist
 * for plugin metadata and the web app), so this catalog builds directly on the
 * shared {@link LocalizedText} shape: every message carries `en` + `ko`, and
 * the CLI renders `ko` by default (product tone), `en` when
 * `TERMINULL_LANG=en`. Noted as a deviation in the M8 progress log.
 */
import type { LocalizedText } from '@terminull/shared';

/** Resolve the CLI output locale. Korean is the product default. */
export function cliLocale(env: NodeJS.ProcessEnv = process.env): 'ko' | 'en' {
  return env.TERMINULL_LANG === 'en' ? 'en' : 'ko';
}

/** Message catalog. `{name}` placeholders are filled by {@link t}. */
export const MESSAGES = {
  'enroll.preflightOk': {
    en: 'host {host} reachable (home: {home})',
    ko: '{host} 호스트에 접속했습니다 (원격 홈: {home})',
  },
  'enroll.nodePinned': {
    en: 'remote node pinned: {path} ({version})',
    ko: '원격 node를 고정했습니다: {path} ({version})',
  },
  'enroll.shadowWarn': {
    en: 'PATH node {shadow} ({shadowVersion}) is shadowed by a newer install — using {path} ({version}) instead',
    ko: 'PATH의 node {shadow} ({shadowVersion})는 더 새로운 설치를 가리고 있어, {path} ({version})를 대신 사용합니다',
  },
  'enroll.uploaded': {
    en: 'agent bundle installed under ~/{dir}',
    ko: '에이전트 번들을 원격 ~/{dir} 아래에 설치했습니다',
  },
  'enroll.probeOk': {
    en: 'agent handshake OK ({preamble})',
    ko: '에이전트 핸드셰이크 확인 완료 ({preamble})',
  },
  'enroll.registered': {
    en: 'machine registered in {file}:',
    ko: '{file}에 머신을 등록했습니다:',
  },
  'enroll.reloaded': {
    en: 'server reloaded the machine registry',
    ko: '서버가 머신 레지스트리를 다시 불러왔습니다',
  },
  'enroll.reloadHint': {
    en: 'server not reloaded ({reason}) — run: curl -X POST http://127.0.0.1:<port>/api/machines/reload (as user) or restart the server',
    ko: '서버 자동 갱신 실패 ({reason}) — 서버 실행 중이면 사용자 권한으로 POST /api/machines/reload 를 호출하거나 서버를 재시작하세요',
  },
  'enroll.done': {
    en: 'enroll complete: {id} ({host})',
    ko: '등록 완료: {id} ({host})',
  },
  'remove.remoteRemoved': {
    en: 'remote directory ~/{dir} removed on {host}',
    ko: '{host}의 원격 디렉터리 ~/{dir} 를 제거했습니다',
  },
  'remove.remoteUnreachable': {
    en: 'host {host} unreachable — remote ~/{dir} may remain; only the local entry was dropped',
    ko: '{host} 호스트에 접속할 수 없어 원격 ~/{dir} 가 남아있을 수 있습니다. 로컬 등록만 해제했습니다',
  },
  'remove.remoteFailed': {
    en: 'remote cleanup on {host} did not complete: {detail}',
    ko: '{host} 원격 정리가 완료되지 않았습니다: {detail}',
  },
  'remove.entryRemoved': {
    en: 'machine {id} deregistered from {file}',
    ko: '머신 {id} 등록을 {file}에서 해제했습니다',
  },
  'remove.entryMissing': {
    en: 'no machines.json entry matched {query}; attempted remote cleanup only',
    ko: '{query} 에 해당하는 machines.json 등록이 없어 원격 정리만 시도했습니다',
  },
  'status.serverLive': {
    en: 'machine states from the running server (port {port})',
    ko: '실행 중인 서버에서 가져온 머신 상태입니다 (포트 {port})',
  },
  'status.serverDown': {
    en: 'server is not running — showing machines.json config only (no live states)',
    ko: '서버가 실행 중이 아닙니다 — machines.json 설정만 표시합니다 (실시간 상태 아님)',
  },
  'status.serverNoApi': {
    en: 'server is running but has no machines API ({detail}) — showing config only',
    ko: '서버는 실행 중이지만 머신 API가 없습니다 ({detail}) — 설정만 표시합니다',
  },
  'status.noMachines': {
    en: 'no remote machines are registered',
    ko: '등록된 원격 머신이 없습니다',
  },
  'error.ssh_auth_required': {
    en: 'ssh authentication to {host} failed (BatchMode) — set up key-based auth (ssh-agent) first',
    ko: '{host} ssh 인증에 실패했습니다 (BatchMode) — 먼저 키 기반 인증(ssh-agent)을 설정하세요',
  },
  'error.ssh_unreachable': {
    en: 'cannot reach host {host}: {detail}',
    ko: '{host} 호스트에 접속할 수 없습니다: {detail}',
  },
  'error.remote_node_missing': {
    en: 'no node >= v{min} found on {host} (probed: {probed}) — pass --node <absolute-path>',
    ko: '{host}에서 v{min} 이상의 node를 찾지 못했습니다 (탐색: {probed}) — --node <절대경로> 로 직접 지정하세요',
  },
  'error.remote_node_invalid': {
    en: '--node {path} is not a usable node >= v{min}: {detail}',
    ko: '--node {path} 는 v{min} 이상의 사용 가능한 node가 아닙니다: {detail}',
  },
  'error.remote_install_failed': {
    en: 'a remote install step failed: {detail}',
    ko: '원격 설치 단계가 실패했습니다: {detail}',
  },
  'error.remote_native_build_failed': {
    en: 'node-pty native rebuild failed on {host}: {detail}',
    ko: '{host}에서 node-pty 네이티브 재빌드에 실패했습니다: {detail}',
  },
  'error.agent_probe_failed': {
    en: 'installed agent did not answer the handshake probe on {host}: {detail}',
    ko: '{host}에 설치된 에이전트가 핸드셰이크 프로브에 응답하지 않았습니다: {detail}',
  },
  'error.machine_id_invalid': {
    en: 'machine id {id} is invalid (lowercase slug, max 32 chars, not "local")',
    ko: '머신 id {id} 가 유효하지 않습니다 (소문자 슬러그, 최대 32자, "local" 금지)',
  },
  'error.machines_file_invalid': {
    en: 'machines.json is invalid: {detail}',
    ko: 'machines.json 파일이 유효하지 않습니다: {detail}',
  },
  'error.bundle_failed': {
    en: 'building the agent bundle failed: {detail}',
    ko: '에이전트 번들 생성에 실패했습니다: {detail}',
  },
  'error.usage': {
    en: 'invalid arguments — see usage below',
    ko: '잘못된 인자입니다 — 아래 사용법을 확인하세요',
  },
} as const satisfies Record<string, LocalizedText>;

export type MessageKey = keyof typeof MESSAGES;

/** Render a catalog message in the CLI locale, filling `{param}` slots. */
export function t(
  key: MessageKey,
  params: Record<string, string | number> = {},
  locale: 'ko' | 'en' = cliLocale(),
): string {
  let text: string = MESSAGES[key][locale];
  for (const [name, value] of Object.entries(params)) {
    text = text.replaceAll(`{${name}}`, String(value));
  }
  return text;
}

/** CLI usage text (Korean-first; command syntax stays literal). */
export function usageText(): string {
  return [
    'terminull — Terminull CLI',
    '',
    '사용법:',
    '  terminull enroll <ssh-host> [--id <slug>] [--label <text>] [--node <원격 node 절대경로>] [--server-state <dir>]',
    '      원격 호스트에 에이전트를 설치하고 머신으로 등록합니다.',
    '  terminull enroll --remove <ssh-host|id> [--server-state <dir>]',
    '      원격 ~/.terminull-agent 제거 + 머신 등록 해제 (완전 되돌리기).',
    '  terminull machines [status] [--server-state <dir>]',
    '      등록된 머신과 실시간 연결 상태를 표시합니다.',
    '',
    '옵션:',
    '  --server-state <dir>   서버 상태 디렉터리 (기본값: ~/.terminull)',
    '  --help                 이 도움말 표시',
    '',
  ].join('\n');
}
