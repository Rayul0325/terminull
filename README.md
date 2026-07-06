# Terminull

**Terminull — 모든 CLI 코딩 에이전트를 위한 하나의 패널.** Claude Code, Codex,
agy(Antigravity), 그리고 임의의 명령줄 도구를 한 화면에서 띄우고, 조종하고,
기록·관리합니다. 로컬 우선(127.0.0.1)으로 동작하는 pnpm + TypeScript 모노레포이며,
공용 코어 · 도구별 어댑터 · PTY 세션 호스트 · 서버 · CLI · React 웹 패널로
구성됩니다. 모든 문자열은 한국어/영어 이중 로케일입니다.

> English: [README.en.md](./README.en.md)

**상태: v0.1.0 (첫 공개 릴리스).** 공개 npm 패키지는 딱 두 개입니다 —
제품 진입점 `terminull`(이 CLI)과 플러그인 작성용 타입/검증 라이브러리
`@terminull/plugin-api`. 나머지 워크스페이스 패키지는 모두 비공개입니다.

---

## 신뢰 먼저 — `npx terminull setup`이 정확히 무엇을 건드리나

Terminull은 각 코딩 에이전트의 설정 파일에 **훅을 심어** 패널이 세션 이벤트를
받아볼 수 있게 합니다. 무엇을, 어디에, 어떻게 넣는지 파일 단위로 아래에
전부 적습니다. **추측하지 말고 이 표를 신뢰하세요 — 코드가 하는 그대로입니다.**

### 도구별 주입 내역 (파일 단위)

| 도구 | 건드리는 파일 | 정확히 추가되는 것 | 원본 처리 |
| --- | --- | --- | --- |
| **Claude Code** | `~/.claude/terminull/hooks/*.sh` (신규 디렉터리) | 훅 스크립트 8개 복사 (7개 이벤트 훅 + 공용 `terminull-lib.sh`) | 신규 디렉터리 — 기존 파일 없음 |
| **Claude Code** | `~/.claude/settings.json` | `hooks` 객체에 항목 7개 추가: `SessionStart`, `UserPromptSubmit`, `PreToolUse`(matcher `AskUserQuestion`), `PostToolUse`(matcher `ExitPlanMode`), `Notification`, `Stop`, `SessionEnd`. **기존 훅·설정은 순서·값 그대로 보존**, 우리 항목만 뒤에 append | 원본을 `settings.json.terminull.bak-<타임스탬프>`로 그대로 백업 후 원자적 교체 |
| **Codex** | `~/.codex/terminull/hooks/*.sh` (신규 디렉터리) | notify 래퍼 2개 복사 (`terminull-codex-notify.sh` + `terminull-lib.sh`) | 신규 디렉터리 |
| **Codex** | `~/.codex/config.toml` | **단 한 줄**, 최상위 `notify = [...]` 배열만 외과적으로 수정. 우리 래퍼를 배열 맨 앞에 넣고, 기존 notify 클라이언트를 체인 실행 → Codex Desktop 동작 그대로. 배열이 없으면 첫 `[table]` 헤더 앞에 `notify` 줄을 새로 삽입 | 원본을 `config.toml.terminull.bak-<타임스탬프>`로 백업. **`[projects."..."]` 신뢰 테이블(디렉터리별 `trust_level`)은 바이트 단위로 그대로 유지** — 절대 재직렬화하지 않습니다 |
| **agy (Antigravity)** | — 없음 — | agy는 훅을 노출하지 않습니다. Terminull은 감지·구동만 하고 **설정 파일을 전혀 건드리지 않습니다** (정직한 한계) | 해당 없음 |

### 모든 변경은 동의를 거칩니다 (diff 미리보기)

`setup`은 도구별로 **먼저 dry-run diff를 그려서 보여준 뒤**, 도구마다 개별
동의(stdin `y/N`)를 받고 나서야 파일을 씁니다. 미리보기는 실제 주입기의
`plan()`이 그대로 만든 것이라 화면에 보이는 것과 디스크에 쓰이는 것이
일치합니다. `--yes`는 CI/자동화용으로 모든 동의를 한 번에 수락합니다.

각 주입 사실(추가된 정확한 바이트, 쓰기 전/후 sha256, 백업 경로)은
`~/.terminull/injected.json` 이력 원장에 기록됩니다. 이 원장이 완전 복원을
바이트 단위로 보장하는 근거입니다.

### 완전 제거 — 바이트 단위 원상복구

```sh
terminull eject [claude|codex]   # 특정 도구만 제거
terminull uninstall              # 모든 도구 제거 + 서비스 정리
```

제거 알고리즘은 원장을 읽어 이렇게 동작합니다:

1. **파일을 설치 이후 손대지 않았으면** → 백업 바이트로 **완전히 동일하게 복원**
   (`settings.json`·`config.toml` 모두 sha256 일치 보장).
2. 우리가 **새로 만든 파일**이고 수정되지 않았으면 → 삭제.
3. 사용자가 그 파일을 **수정했으면**(drift) → 우리가 넣은 정확한 조각만 외과적으로
   떼어내고 나머지 사용자 편집은 **그대로 둡니다**.
4. 우리 조각이 사라졌거나 변형됐으면 → 파일을 **건드리지 않고 경고만** 출력.
   절대 사용자 편집을 덮어쓰지 않습니다.

`uninstall`은 데이터 디렉터리(`~/.terminull`)를 지우지 않습니다. 삭제하려면
`--purge`와 대화형 확인을 함께 줘야 합니다 (`--yes`만으로는 데이터가
남습니다).

> 주입 엔진의 코어 프리미티브(JSON append-dedup, TOML 단일 줄 수술, 이력 원장)와
> 어댑터 주입기는 fake home(임시 디렉터리) 위에서 골든 테스트로 검증됩니다.
> **실제 `~/.claude`·`~/.codex`는 테스트에서 절대 건드리지 않습니다.**

---

## 빠른 시작

```sh
# 아직 npm 게시 전 — 로컬 워크스페이스에서:
corepack enable
pnpm install
pnpm -r build

# 게시 후 (v0.1.0):
npx terminull setup     # 도구 감지 → diff 미리보기 → 동의 → 주입 → 패널 실행
```

`setup`은 다음을 순서대로 합니다: 엔진 점검(Node ≥ 22) → 설치된 도구 감지
(claude/codex/agy 바이너리 + `--version`; 없으면 정직하게 건너뜀) → 도구별
diff 미리보기 + 개별 동의 → 주입 + 원장 기록 → 로컬 패널 서비스 설치 →
합성 이벤트 왕복 헬스체크 → 패널 URL 출력.

문제 진단은 `terminull doctor`가 환경(Node·PATH), 상태 디렉터리·`server.json`·
프로세스 생존, 소켓 도달성, 서비스 상태, 버전, 번들 무결성 해시를 각각
녹/적으로 보고합니다.

---

## 지금 되는 것 (릴리스된 기능만)

- **여러 CLI 에이전트를 한 패널에서** — dockview 워크스페이스, 도구별 렌더러
  레지스트리, 실시간 터미널(PTY), 한/영 i18n (M6).
- **딥 어댑터** — Claude Code(트랜스크립트 파싱·구동·훅 주입), Codex(rollout
  파서·`exec --json` 구동·토큰 사용량·notify 주입) (M4·M7).
- **에이전트 관리·승인** — 감독(supervisor) 브레인, 제안된 액션 승인 인박스,
  권한 토글, 도구 사용량 게이지 (M7).
- **다중 머신** — SSH stdio 릴레이 에이전트를 원격 호스트에 설치(`enroll`),
  머신 레지스트리, 머신 태그 세션, 웹 머신 배지·신선도 칩 (M8).
- **하네스 편집** — sha 잠금 낙관적 쓰기 + 백업 회전으로 도구 설정 파일을
  패널에서 안전하게 diff·수정, 계정 센터, 세션 생성 스텝퍼, 키바인딩 에디터,
  모바일 셸 (M9).
- **설치·제거 + 플러그인 + 데스크톱 셸** — 위의 신뢰 우선 주입/제거, 플러그인
  검증기, Electron 씬 셸 스켈레톤 (M10, 이 릴리스).

## 다중 머신

```sh
terminull enroll <ssh-host> [--label <이름>]   # 원격에 릴레이 에이전트 설치
terminull enroll <ssh-host> --remove           # 완전 되돌리기
terminull machines status                       # 등록된 머신 상태
```

원격 발자국은 `~/.terminull-agent/` 하나로 한정되며, `VERSION` 파일을 **맨
마지막에** 써서 그 존재 = 설치 완료를 뜻합니다(재실행은 멱등 업그레이드).
모든 원격 바이트는 SSH 릴레이 심(seam)을 지납니다.

## 플러그인 (작성 키트)

플러그인은 **코어를 절대 수정하지 않고** 8개 기여 지점(contribution points)으로만
확장합니다: `adapters` · `renderers` · `panels` · `themes` · `locales` ·
`keymaps` · `harnessForms` · `commands`.

- **`@terminull/plugin-api`** (공개 npm 패키지) — 매니페스트 zod 스키마, semver
  게이트(`PLUGIN_API_VERSION`), 그리고 `@terminull/plugin-api/validate`의
  `validatePluginDir()` 실검증기(매니페스트 발견 → 스키마 → semver → 모듈 감옥
  → 중복 id). 이게 기계 오라클입니다.
- **`terminull plugins validate <dir>`** — 위 검증기를 감싸 오류를 `at` 경로와
  함께 출력(에러 있으면 exit 1, `--json`은 기계용).
- **`terminull plugins scaffold <point> <name>`** — 템플릿 생성. theme·panel·
  locale이 1급이며, 생성 직후 즉시 `validate`를 통과합니다.
- 작성 가이드: `docs/plugin-authoring/SKILL.md`(Claude 에이전트용) ·
  `docs/plugin-authoring/AGENTS.md`(Codex/Gemini용), 루트 `llms.txt`(1페이지
  요약), `examples/`의 예제 플러그인 3종(테마·패널·ja 로케일). 첫 줄 가드레일:
  **"코어를 수정하지 말 것 — 8개 기여 지점으로만 확장하고, 편집할 때마다
  `terminull plugins validate`가 초록이 될 때까지 반복하라."**

## 지원 도구 매트릭스 (티어 정직성)

| 도구 | 티어 | 감지 | 구동(PTY) | 트랜스크립트 렌더 | 하네스 주입 |
| --- | --- | --- | --- | --- | --- |
| **Claude Code** | 딥 | ✅ PID 레지스트리 | ✅ 키맵·퀵 | ✅ 네이티브 파싱 | ✅ 훅 7개 |
| **Codex** | 딥 | ✅ rollout | ✅ `exec --json` | ✅ rollout 파서 | ✅ notify 한 줄 |
| **agy (Antigravity)** | 요약 | ✅ | ✅ | 🟡 요약 카드(단계별 렌더는 v1 비약속) | ❌ 없음(훅 미노출) |
| **ACP 에이전트** | 제네릭 | 프로토콜 | 🟡 | 제네릭 | ❌ (스캐폴드 단계) |
| **임의 CLI** | 제네릭 PTY | 수동 | ✅ 원본 PTY | 원본 터미널 | ❌ |

"딥"은 트랜스크립트를 네이티브로 파싱하고 구동·훅 주입까지 하는 티어,
"제네릭"은 PTY 패스스루로 아무 CLI나 띄우는 티어입니다. 기능별 상세 격차는
[docs/parity/gap-matrix.md](./docs/parity/gap-matrix.md)에 정직하게 적혀 있습니다.

## 로드맵 (v1.1 백로그)

- **OpenCode 딥 어댑터** — 제네릭을 넘어선 네이티브 지원.
- **플러그인 스토어 UI** — 패널 안에서 플러그인 탐색·설치.
- **Windows 지원** — 현재 서비스 관리는 darwin(launchd) 전용, linux/windows는
  정직한 `unsupported` 스텁.
- **서명된 빌드** — 데스크톱 셸 패키징·코드 서명(v0.x는 문서화된 서명 없는
  로컬 빌드).

---

## 개발

```sh
corepack enable
pnpm install
pnpm -r build
pnpm -r test
pnpm lint
pnpm typecheck
```

## 보안

위협 모델·네트워크 자세·시크릿 처리·신고 채널은 [SECURITY.md](./SECURITY.md)를
보세요. 요약: 서버는 기본 127.0.0.1(루프백)만 바인딩하고, 주입은 동의 기반 +
이력 원장으로 되돌릴 수 있으며, **패널은 감사·거버넌스 계층이지 샌드박스가
아닙니다** — 에이전트는 여전히 사용자 권한으로 실행됩니다.

## 릴리스

게시 절차와 롤백은 [docs/release-checklist.md](./docs/release-checklist.md)에
있습니다. 변경 이력은 [CHANGELOG.md](./CHANGELOG.md).

## 라이선스

[MIT](./LICENSE) © 2026 Rayul
