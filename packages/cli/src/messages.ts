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

  // --- setup / inject ---
  'setup.unknownTool': {
    en: 'unknown tool {tool} — injectable tools: {tools}',
    ko: '알 수 없는 도구 {tool} — 주입 가능한 도구: {tools}',
  },
  'setup.nodeTooOld': {
    en: 'node {version} is too old — Terminull needs node >= 22',
    ko: 'node {version}은 너무 낮습니다 — Terminull은 node 22 이상이 필요합니다',
  },
  'setup.toolMissing': {
    en: '{tool}: CLI not found on PATH — skipping (nothing installed)',
    ko: '{tool}: PATH에서 CLI를 찾지 못해 건너뜁니다 (설치 안 함)',
  },
  'setup.toolFound': {
    en: '{tool}: detected ({version})',
    ko: '{tool}: 감지됨 ({version})',
  },
  'setup.alreadyInjected': {
    en: '{tool}: already injected (ledger present) — no change',
    ko: '{tool}: 이미 주입되어 있습니다 (원장 존재) — 변경 없음',
  },
  'setup.consent': {
    en: 'Inject the Terminull harness into {tool}? [y/N] ',
    ko: '{tool}에 Terminull 하네스를 주입할까요? [y/N] ',
  },
  'setup.skipped': {
    en: '{tool}: skipped by user',
    ko: '{tool}: 사용자가 건너뛰었습니다',
  },
  'setup.injectFailed': {
    en: '{tool}: injection failed: {detail}',
    ko: '{tool}: 주입 실패: {detail}',
  },
  'setup.injected': {
    en: '{tool}: injected ({files} file record(s) tracked for eject)',
    ko: '{tool}: 주입 완료 (제거용으로 파일 {files}개를 원장에 기록)',
  },
  'setup.noTools': {
    en: 'no supported CLI tools were found on this machine',
    ko: '이 컴퓨터에서 지원하는 CLI 도구를 찾지 못했습니다',
  },
  'setup.serviceInstalled': {
    en: 'panel background service installed (launchd, RunAtLoad)',
    ko: '패널 백그라운드 서비스를 설치했습니다 (launchd, 로그인 시 실행)',
  },
  'setup.serviceUnsupported': {
    en: 'background service is macOS-only in v0.x — skipped on this platform',
    ko: '백그라운드 서비스는 v0.x에서 macOS 전용입니다 — 이 플랫폼에서는 건너뜀',
  },
  'setup.serviceFailed': {
    en: 'panel service install failed: {detail}',
    ko: '패널 서비스 설치 실패: {detail}',
  },
  'setup.healthOk': {
    en: '{tool}: synthetic event round-trip OK (injected chain verified)',
    ko: '{tool}: 합성 이벤트 왕복 확인 (주입 경로 검증됨)',
  },
  'setup.healthUnavailable': {
    en: '{tool}: healthcheck unavailable: {detail}',
    ko: '{tool}: 헬스체크 불가: {detail}',
  },
  'setup.healthFailed': {
    en: '{tool}: synthetic event NOT observed: {detail}',
    ko: '{tool}: 합성 이벤트가 확인되지 않음: {detail}',
  },
  'setup.panelUrl': {
    en: 'panel: {url}',
    ko: '패널 주소: {url}',
  },
  'setup.panelNotRunning': {
    en: 'panel server is not running — start it with `terminull serve` (healthcheck skipped)',
    ko: '패널 서버가 실행 중이 아닙니다 — `terminull serve`로 시작하세요 (헬스체크 건너뜀)',
  },

  // --- eject ---
  'eject.nothing': {
    en: '{tool}: nothing to eject (no ledger entry)',
    ko: '{tool}: 제거할 항목이 없습니다 (원장 없음)',
  },
  'eject.file': {
    en: '  {outcome}: {path}',
    ko: '  {outcome}: {path}',
  },
  'eject.drift': {
    en: '{tool}: left drifted file(s) untouched — resolve manually then re-run eject',
    ko: '{tool}: 사용자가 수정한 파일을 그대로 두었습니다 — 직접 정리 후 eject를 다시 실행하세요',
  },
  'eject.clean': {
    en: '{tool}: ejected cleanly (byte-restored / removed)',
    ko: '{tool}: 깨끗하게 제거했습니다 (원본 복원 / 삭제)',
  },

  // --- doctor ---
  'doctor.header': { en: 'terminull doctor', ko: 'terminull doctor 진단' },
  'doctor.node': { en: 'node {version}', ko: 'node {version}' },
  'doctor.nodeTooOld': {
    en: 'node {version} < 22 (upgrade required)',
    ko: 'node {version} < 22 (업그레이드 필요)',
  },
  'doctor.serverDown': {
    en: '  · panel server not running (start with `terminull serve`)',
    ko: '  · 패널 서버가 실행 중이 아닙니다 (`terminull serve`로 시작)',
  },
  'doctor.serverLive': {
    en: 'panel server live (port {port}, pid {pid})',
    ko: '패널 서버 실행 중 (포트 {port}, pid {pid})',
  },
  'doctor.socketOk': { en: 'events API reachable ({url})', ko: '이벤트 API 연결됨 ({url})' },
  'doctor.socketBad': {
    en: 'events API NOT reachable ({url}): {status}',
    ko: '이벤트 API 연결 실패 ({url}): {status}',
  },
  'doctor.serviceUnsupported': {
    en: '  · background service: macOS-only in v0.x',
    ko: '  · 백그라운드 서비스: v0.x에서는 macOS 전용',
  },
  'doctor.serviceLoaded': { en: 'launchd service loaded', ko: 'launchd 서비스 로드됨' },
  'doctor.serviceNotLoaded': {
    en: 'launchd plist present but NOT loaded (run `terminull setup`)',
    ko: 'launchd plist는 있으나 로드되지 않음 (`terminull setup` 실행)',
  },
  'doctor.serviceAbsent': {
    en: '  · background service not installed',
    ko: '  · 백그라운드 서비스가 설치되어 있지 않음',
  },
  'doctor.version': { en: 'version {version}', ko: '버전 {version}' },
  'doctor.noInjection': {
    en: '  · no harness injected (run `terminull setup`)',
    ko: '  · 주입된 하네스가 없습니다 (`terminull setup` 실행)',
  },
  'doctor.integrityOk': {
    en: '{tool}: injected artifacts intact (sha match)',
    ko: '{tool}: 주입 산출물 무결성 확인 (sha 일치)',
  },
  'doctor.integrityMissing': {
    en: '{tool}: injected file missing: {path}',
    ko: '{tool}: 주입 파일 누락: {path}',
  },
  'doctor.integrityDrift': {
    en: '{tool}: injected file changed since install: {path}',
    ko: '{tool}: 설치 이후 주입 파일이 변경됨: {path}',
  },
  'doctor.healthy': { en: 'doctor: all checks passed', ko: 'doctor: 모든 점검 통과' },
  'doctor.unhealthy': {
    en: 'doctor: one or more checks failed (see ✖ above)',
    ko: 'doctor: 하나 이상의 점검이 실패했습니다 (위 ✖ 확인)',
  },

  // --- uninstall ---
  'uninstall.serviceRemoved': {
    en: 'panel background service removed',
    ko: '패널 백그라운드 서비스를 제거했습니다',
  },
  'uninstall.serviceFailed': {
    en: 'service removal failed: {detail}',
    ko: '서비스 제거 실패: {detail}',
  },
  'uninstall.dataKept': {
    en: 'data dir kept at {dir} (pass --purge to delete it)',
    ko: '데이터 디렉터리를 {dir}에 남겨두었습니다 (삭제하려면 --purge 사용)',
  },
  'uninstall.purgeConfirm': {
    en: 'permanently delete {dir} and ALL panel data? [y/N] ',
    ko: '{dir}와 모든 패널 데이터를 영구 삭제할까요? [y/N] ',
  },
  'uninstall.dataPurged': {
    en: 'data dir {dir} deleted',
    ko: '데이터 디렉터리 {dir}를 삭제했습니다',
  },

  // --- plugins ---
  'plugins.validateOk': { en: 'plugin OK: {dir}', ko: '플러그인 유효: {dir}' },
  'plugins.validateFail': {
    en: 'plugin INVALID: {dir}',
    ko: '플러그인 유효하지 않음: {dir}',
  },
  'plugins.scaffoldBadPoint': {
    en: 'unknown contribution point {point}',
    ko: '알 수 없는 기여 지점 {point}',
  },
  'plugins.scaffoldFailed': { en: 'scaffold failed: {detail}', ko: '스캐폴드 실패: {detail}' },
  'plugins.scaffolded': {
    en: 'scaffolded {count} file(s) into {dir}',
    ko: '{dir}에 파일 {count}개를 생성했습니다',
  },
  'plugins.scaffoldInvalid': {
    en: 'scaffold did NOT pass validation — this is a bug',
    ko: '생성된 스캐폴드가 검증을 통과하지 못했습니다 — 버그입니다',
  },
  'plugins.scaffoldValidated': {
    en: 'scaffold validated ✓ — edit the module, then `terminull plugins validate`',
    ko: '스캐폴드 검증 통과 ✓ — 모듈을 수정한 뒤 `terminull plugins validate`를 실행하세요',
  },
  'plugins.addNotFound': {
    en: 'plugin source not found: {source}',
    ko: '플러그인 소스를 찾을 수 없습니다: {source}',
  },
  'plugins.addNotDir': {
    en: 'tarball install is not supported in v0.x — pass a plugin directory: {source}',
    ko: 'v0.x에서는 tarball 설치를 지원하지 않습니다 — 플러그인 디렉터리를 지정하세요: {source}',
  },
  'plugins.addInvalid': {
    en: 'refusing to add invalid plugin: {source}',
    ko: '유효하지 않은 플러그인은 추가하지 않습니다: {source}',
  },
  'plugins.added': {
    en: 'plugin {name} added at {dir}',
    ko: '플러그인 {name}을 {dir}에 추가했습니다',
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
    '설치 / 제거:',
    '  terminull setup [claude|codex] [--yes]',
    '      도구 감지 → 주입 미리보기 → 도구별 동의 → 하네스 주입 → 서비스 → 헬스체크.',
    '  terminull inject [claude|codex] [--yes]   하네스 주입만 실행 (동의 + 원장).',
    '  terminull eject [claude|codex]            주입한 하네스를 되돌립니다 (드리프트 존중).',
    '  terminull doctor                          환경/서버/서비스/무결성 진단.',
    '  terminull uninstall [--purge]             전체 제거 (--purge + 확인 시에만 데이터 삭제).',
    '',
    '플러그인:',
    '  terminull plugins validate <dir> [--json]',
    '  terminull plugins scaffold <point> <name> [--dir <targetDir>]',
    '  terminull plugins add <dir>',
    '',
    '옵션:',
    '  --server-state <dir>   서버 상태 디렉터리 (기본값: ~/.terminull)',
    '  --yes                  모든 동의 프롬프트를 자동 승인 (CI/무인 실행)',
    '  --purge                uninstall 시 데이터 디렉터리까지 삭제 (확인 필요)',
    '  --json                 기계 판독용 JSON 출력 (plugins validate)',
    '  --help                 이 도움말 표시',
    '',
  ].join('\n');
}
