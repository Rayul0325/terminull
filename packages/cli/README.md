# terminull

CLI 코딩 에이전트(Claude Code · Codex)를 위한 **로컬 관제 패널**입니다. 서버는
`127.0.0.1`에만 바인딩하고, 하네스 주입은 **동의 기반**이며 **바이트 단위로 되돌릴
수 있게** 설계되었습니다. 자격증명 파일은 절대 읽지 않습니다.

```bash
npx terminull setup      # 도구 감지 → 주입 미리보기 → 도구별 동의 → 주입 → 헬스체크
```

## setup이 정확히 무엇을 주입하나

`terminull setup`은 감지된 도구마다 **미리보기를 보여주고 개별 동의를 받은 뒤**에만
아래를 설치합니다. 무엇을 바꿨는지는 전부 `<상태 디렉터리>/injected.json`(프로비넌스
원장)에 기록되어, `eject`가 원본을 그대로 복원합니다.

| 도구 | 주입 대상 | 내용 | 되돌리기 |
| --- | --- | --- | --- |
| Claude Code | `~/.claude/settings.json` | 7개 이벤트 훅 항목을 **기존 항목 뒤에 추가**(파싱→append→원자적 쓰기). 기존 훅은 순서·값 보존 | 수정 없으면 백업에서 **바이트 동일** 복원, 아니면 우리 항목만 제거 |
| Claude Code | `~/.claude/terminull/hooks/*.sh` | 훅 스크립트 복사(패널 다운 시 무해한 no-op) | 파일 삭제 |
| Codex | `~/.codex/config.toml` | `notify` 배열 한 줄만 **외과적 패치**(재직렬화 안 함 → `[projects.*]` 신뢰 테이블 바이트 보존) | 우리 원소만 제거, 원본 **바이트 동일** 복원 |
| Codex | `~/.codex/terminull/hooks/*.sh` | notify 래퍼 + 라이브러리 복사 | 파일 삭제 |

추가로 macOS에서는 패널 백그라운드 서비스(LaunchAgent, `com.terminull.panel`)를
설치합니다. 데이터·설정은 `~/.terminull`(상태 디렉터리)에 저장됩니다.

## 완전히 제거하는 법

```bash
terminull eject             # 주입한 하네스만 되돌리기 (설정 파일 바이트 복원)
terminull eject claude      # 특정 도구만
terminull uninstall         # 전체 제거: 모든 도구 eject + 서비스 제거 (데이터는 보존)
terminull uninstall --purge # 위 + ~/.terminull 데이터까지 삭제 (대화형 확인 필요)
```

- **드리프트 존중**: 주입 이후 설정 파일을 직접 수정했다면, 우리 조각이 그대로 남아
  있으면 그 부분만 외과적으로 제거하고, 사라졌으면 파일을 **건드리지 않고 경고**만
  남깁니다. 사용자의 수정은 절대 덮어쓰지 않습니다.
- `--yes`만으로는 **데이터를 삭제하지 않습니다**. 데이터 삭제는 `--purge` + 명시적
  확인이 함께 있어야만 실행됩니다.

## 명령

| 명령 | 설명 |
| --- | --- |
| `terminull setup [claude\|codex] [--yes]` | 감지 → 미리보기 → 동의 → 주입 → 서비스 → 합성 이벤트 헬스체크 |
| `terminull inject [claude\|codex] [--yes]` | 하네스 주입만 (동의 + 원장) |
| `terminull eject [claude\|codex]` | 되돌리기 (드리프트 존중, 파일별 결과 출력) |
| `terminull doctor` | 환경 · 서버 · 소켓 · 서비스 · 버전 · 주입 무결성(sha) 진단 |
| `terminull uninstall [--purge]` | 전체 제거 (`--purge` + 확인 시에만 데이터 삭제) |
| `terminull serve [--port <n>] [--host <addr>]` | 로컬 패널 서버 실행 (기본 `127.0.0.1`) |
| `terminull plugins validate <dir> [--json]` | 플러그인 디렉터리 검증 |
| `terminull plugins scaffold <point> <name> [--dir <경로>]` | 플러그인 템플릿 생성(생성 즉시 검증) |
| `terminull plugins add <dir>` | 플러그인을 상태 디렉터리에 설치 + 등록 |

한국어가 기본, `TERMINULL_LANG=en`으로 영어 출력.

## 플러그인

8개 기여 지점(`adapters renderers panels themes locales keymaps harnessForms
commands`) 위에서 동작하며, 계약과 검증기는 `@terminull/plugin-api`가
단일 원천입니다. `terminull plugins validate`가 기계 판독 가능한 오라클입니다 —
편집할 때마다 실행해 초록이 될 때까지 반복하세요.

## 보안

패널은 **거버넌스 레이어이지 샌드박스가 아닙니다** — 에이전트는 여전히 사용자
권한으로 실행됩니다. 서버는 루프백에만 바인딩하고, 자격증명 본문은 읽지 않으며,
민감 문자열은 이벤트 전송 전에 마스킹됩니다. 자세한 위협 모델은 저장소의
`SECURITY.md`를 참고하세요.

## 라이선스

MIT
