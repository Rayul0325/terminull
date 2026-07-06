# 보안 정책 · Security Policy

<!--
  한국어 먼저, 영어는 아래(English below). 이 문서의 모든 주장은 코드로
  뒷받침됩니다: 서버 바인딩/경고(packages/server/src/app.ts, bin.ts), 인증
  3중 검사(packages/server/src/auth.ts), 시크릿 마스킹(packages/core/src/mask.ts),
  주입 이력 원장(packages/core/src/harness-injection.ts), 어댑터 주입기
  (packages/adapters/{claude,codex}/src/injector.ts).
-->

## 1. 위협 모델 요약

Terminull은 사용자의 컴퓨터에서 코딩 에이전트를 띄우고 조종하며, 그 에이전트는
**사용자와 동일한 권한**으로 셸 명령·파일 접근을 수행합니다. 따라서 보안 설계의
출발점은 다음 한 문장입니다.

> **패널은 감사·거버넌스 계층이지 샌드박스가 아닙니다.** Terminull은 무엇이
> 주입됐는지 기록하고, 상태 변경에 동의를 요구하고, 시크릿을 마스킹합니다.
> 하지만 **프롬프트 인젝션에 넘어간 로컬 프로세스는 방어할 수 없습니다** —
> 같은 uid로 실행되는 에이전트는 사용자의 파일을 읽고 명령을 실행할 수 있고,
> 이는 격리가 아니라 운영체제 권한의 문제입니다. Terminull이 강제하는 경계는
> "자격 증명을 제시하지 않으면 `user`로 승격되지 않는다"는 것이지, "로컬
> 프로세스가 해를 끼칠 수 없다"가 아닙니다. 이 한계를 감추지 않습니다.

즉, Terminull이 지키는 것과 지키지 못하는 것을 명확히 구분합니다.

| 지킴 (설계로 보장)                           | 못 지킴 (범위 밖)                         |
| -------------------------------------------- | ----------------------------------------- |
| 기본 루프백 전용 바인딩 (네트워크 노출 차단) | 사용자 권한으로 도는 에이전트의 자체 행위 |
| CSWSH/CSRF 방어 (Origin 검사)                | 프롬프트 인젝션된 로컬 프로세스           |
| 자격 증명 없이는 `user`로 승격 안 됨         | 같은 uid가 0600 토큰 파일을 읽는 것       |
| 동의 기반 · 되돌릴 수 있는 주입              | 커널/OS 수준 격리                         |
| 시크릿 마스킹 (베스트 에포트)                | 완전한 시크릿 유출 차단 보장              |

## 2. 네트워크 자세 (루프백 우선)

- 서버 기본 바인딩은 **`127.0.0.1:7420`** 입니다
  (`DEFAULT_HOST`/`DEFAULT_PORT`).
- **와일드카드 주소 바인딩은 `--unsafe-bind` 없이는 거부됩니다.** 특정 비루프백
  주소는 실행되지만 다음 경고를 출력합니다: 이 포트에 도달 가능한 누구나
  토큰만 얻으면 세션·PTY 입력·이벤트 로그를 조종할 수 있으니, 가능하면 루프백 +
  터널(SSH/Tailscale)을 쓰라.
- 데스크톱 셸(Electron)은 **로컬 번들만 로드**하고 `127.0.0.1:<port>`
  (server.json에서 발견)에만 말을 겁니다. 원격 콘텐츠 로딩·네이티브 모듈이
  전혀 없고, 팝아웃은 루프백 동일 앱 URL만 허용합니다.
- 다중 머신은 SSH stdio 릴레이로만 동작합니다 — 원격에 포트를 열지 않습니다.

## 3. 인증 · 행위자 분류

요청마다 세 가지 독립 검사를 적용합니다 (control-tower 모델의 TS 포팅):

- **`authed`** — 이 요청이 서버와 대화할 수 있나? 루프백은 기본 신뢰(설정 가능),
  그 외에는 베어러 토큰 또는 등록 쿠키가 필요.
- **`originOk`** — WS 업그레이드와 상태 변경 요청에 대한 동일 출처 검사. 브라우저
  안의 악성 페이지는 루프백이라 `authed`는 통과하지만 자체 `Origin`을 실어
  보내므로 걸러집니다(CSWSH/CSRF 방어). 훅·curl은 Origin이 없어 통과.
- **`actorOf`** — 누가 행위하는가(권한 게이팅용). `user`는 **양성 자격 증명**
  (쿠키/베어러)을 요구하고, 에이전트·훅은 self-label 헤더로 더 엄격한 권한
  클래스에 스스로를 묶습니다. 맨 루프백 요청은 `unknown`이며 **절대 조용히
  user로 승격되지 않습니다.**

토큰 파일과 `server.json` 발견 파일은 `0600`으로 생성됩니다. 다만 §1의 정직성:
같은 uid 프로세스가 0600 토큰을 읽는 것은 막을 수 없습니다.

## 4. 주입의 안전성 (동의 기반 · 되돌릴 수 있음)

- 모든 주입은 **먼저 diff 미리보기 → 도구별 동의 → 그 다음 쓰기** 순서입니다.
- 이력 원장 `~/.terminull/injected.json`이 추가된 정확한 바이트, 쓰기 전/후
  sha256, 백업 경로를 기록합니다.
- JSON(`settings.json`)은 파싱 → append(중복 제거) → 원자적 쓰기이며 사용자
  항목의 순서·값을 보존합니다. TOML(`config.toml`)은 **단일 줄 외과 수술**로만
  수정하고 절대 재직렬화하지 않아 `[projects.*]` 신뢰 테이블이 바이트 단위로
  살아남습니다.
- 제거는 손대지 않은 파일을 **바이트 단위로 복원**하고, 사용자가 수정한 파일은
  우리 조각만 떼어내거나(외과) 건드리지 않고 경고만(drift) 남깁니다.
- **자격 증명 본문을 읽지 않습니다.** 주입기·감지기는 `auth.json`,
  `.credentials.json`, 토큰 파일의 내용을 절대 읽지 않으며 존재 여부만 봅니다.

## 5. 시크릿 처리

- 자유 텍스트 속 명백한 자격 증명은 리터럴 `[REDACTED]`로 마스킹됩니다
  (`sk-…`, GitHub `gh[pousr]_…`, Slack `xox[baprs]-…`, AWS `AKIA/ASIA…`, JWT
  `eyJ…`, `npm_…`, `sk_/pk_/whsec_/api_/key_/token_/secret_…`). 보수적·선형
  패턴이라 백트래킹 폭발이 없습니다. **베스트 에포트**이며 모든 시크릿 유출을
  막는다고 약속하지 않습니다.
- 상태 파일은 최소 권한(`0600`)으로 씁니다. 이벤트 감사 로그는 내용 없이
  사실만 기록하는 것을 원칙으로 합니다.
- 시크릿을 소스에 하드코딩하지 않습니다 — 환경 변수 + gitignore된 로컬 상태.

## 6. 취약점 신고

- 공개 이슈에 취약점을 올리지 마세요. 관리자에게 **비공개로** 제보해 주세요.
- 포함해 주실 것: 영향받는 버전/커밋, 재현 절차, 영향 범위, 가능하면 PoC.
- 시크릿·토큰은 제보 본문에서 `[REDACTED]`로 가려 주세요.
- 조율된 공개(coordinated disclosure)를 따릅니다: 확인 → 수정 → 릴리스 →
  CHANGELOG 기재 순.

---

# Security Policy (English)

> All claims here are backed by code: server bind/warning
> (`packages/server/src/app.ts`, `bin.ts`), the 3-check auth model
> (`packages/server/src/auth.ts`), secret masking
> (`packages/core/src/mask.ts`), the provenance ledger
> (`packages/core/src/harness-injection.ts`), and the adapter injectors
> (`packages/adapters/{claude,codex}/src/injector.ts`).

## 1. Threat model summary

Terminull launches and drives coding agents on your machine, and those agents run
shell commands and access files **with your own privileges**. The security design
therefore starts from one sentence:

> **The panel is an audit/governance layer, NOT a sandbox.** Terminull records
> what was injected, requires consent for state changes, and masks secrets. But
> **a prompt-injected local process cannot be defended against** — an agent
> running under your uid can read your files and run commands, and that is an OS
> privilege reality, not an isolation feature. The boundary Terminull enforces is
> "nothing becomes `user` without presenting a credential", NOT "a local process
> can do no harm". We do not hide this limit.

| Enforced (by construction)                          | Out of scope                                   |
| --------------------------------------------------- | ---------------------------------------------- |
| Loopback-only bind by default (no network exposure) | An agent's own actions under your uid          |
| CSWSH/CSRF defense (Origin check)                   | A prompt-injected local process                |
| No promotion to `user` without a credential         | A same-uid process reading the 0600 token file |
| Consent-shaped, reversible injection                | Kernel/OS-level isolation                      |
| Secret masking (best-effort)                        | A guarantee against all secret leakage         |

## 2. Network posture (loopback-first)

- The server binds **`127.0.0.1:7420`** by default (`DEFAULT_HOST`/
  `DEFAULT_PORT`).
- **Binding a wildcard address is refused without `--unsafe-bind`.** A specific
  non-loopback host runs but prints a warning: anyone who can reach the port and
  read the token can drive your sessions, PTY input, and event log — prefer
  loopback + a tunnel (SSH/Tailscale).
- The desktop shell (Electron) **loads the local bundle only** and talks only to
  `127.0.0.1:<port>` (discovered via `server.json`). Zero remote content
  loading, zero native modules; popouts are allowed only for loopback same-app
  URLs.
- Multi-machine works over an SSH stdio relay only — it opens no remote port.

## 3. Authentication & actor classification

Three independent per-request checks (a TS port of the control-tower model):

- **`authed`** — may this request talk to the server at all? Loopback is trusted
  by default (configurable); everything else needs the bearer token or the
  enrolment cookie.
- **`originOk`** — same-origin check on WS upgrades and state-changing requests.
  A malicious page in your browser IS loopback (so `authed` passes) but carries
  its own `Origin`, so it is rejected (CSWSH + CSRF defense). Hooks/curl send no
  Origin and pass.
- **`actorOf`** — who is acting, for permission gating. `user` requires a
  POSITIVE credential (cookie or bearer); agents/hooks self-label into their
  (stricter) permission class via a header; a bare loopback request is
  `unknown` and is **never silently promoted to user**.

Token files and the `server.json` discovery file are created `0600`. Per the
honesty in §1: this does not stop a same-uid process from reading that 0600
token.

## 4. Injection safety (consent-shaped, reversible)

- Every injection is **diff preview first → per-tool consent → then write**.
- The provenance ledger `~/.terminull/injected.json` records the exact bytes
  added, sha256 before/after, and the backup path.
- JSON (`settings.json`) is parse → append (dedup) → atomic write, preserving
  user entries' order and values. TOML (`config.toml`) is patched by
  **single-line surgery only, never reserialized**, so `[projects.*]` trust
  tables survive byte-identically.
- Eject **restores untouched files byte-identically**; for user-edited files it
  either surgically strips only our fragment, or leaves the file with a warning
  (drift) — never clobbering user edits.
- **Credential bodies are never read.** Injectors/detectors never read the
  contents of `auth.json`, `.credentials.json`, or token files — only whether
  they exist.

## 5. Secrets handling

- Obvious credentials in free text are masked to the literal `[REDACTED]`
  (`sk-…`, GitHub `gh[pousr]_…`, Slack `xox[baprs]-…`, AWS `AKIA/ASIA…`, JWT
  `eyJ…`, `npm_…`, `sk_/pk_/whsec_/api_/key_/token_/secret_…`). Patterns are
  conservative and linear (no catastrophic backtracking). This is **best-effort**
  and is not a guarantee against all leakage.
- State files are written least-privilege (`0600`). The event audit log records
  facts without content by design.
- No secrets are hardcoded in source — env vars + gitignored local state.

## 6. Reporting a vulnerability

- Do not open a public issue for a vulnerability. Report it **privately** to the
  maintainer.
- Please include: affected version/commit, reproduction steps, impact, and a PoC
  if possible.
- Mask any secret/token as `[REDACTED]` in your report.
- We follow coordinated disclosure: confirm → fix → release → note in the
  CHANGELOG.
