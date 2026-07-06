# 릴리스 체크리스트 — v0.1.0

> **실행 주체는 오케스트레이터입니다.** 이 문서는 절차를 *준비*할 뿐,
> 실제 `npm publish` · `git tag` · GitHub 릴리스는 오케스트레이터가 수행합니다.
> `npm publish`는 **라율의 OTP(2FA TOTP 코드)**가 필요합니다 — 해당 순간에만
> 사람이 개입합니다. 어떤 M10 트랙도 실제 게시·태그·릴리스를 하지 않습니다.

게시 대상 공개 패키지는 **딱 둘**입니다:

1. `@terminull/plugin-api` (packages/plugin-api) — 플러그인 작성용 타입/검증
2. `terminull` (packages/cli) — 제품 진입점, `npx terminull setup`

나머지 워크스페이스 패키지는 모두 `"private": true`라 게시되지 않습니다.

---

## 0. 사전 점검 (Preflight)

깨끗한 체크아웃(main, 최신)에서 순서대로:

```sh
corepack enable
pnpm install --no-frozen-lockfile
pnpm -r build          # 모든 패키지 빌드 (web dist 포함 — prepack이 복사)
pnpm -r test           # 전체 테스트 그린
pnpm lint
pnpm typecheck
```

- [ ] 위 5개 모두 그린.
- [ ] **pack smoke 로컬 실행** (§3). CI의 `pack-smoke` 잡과 동일.
- [ ] `git status --porcelain`이 **비어 있음** — pack이 워크스페이스를 변형하지
      않았는지 확인 (게이트 f).
- [ ] 두 패키지의 `version`이 `0.1.0`인지 확인:
      `packages/plugin-api/package.json`, `packages/cli/package.json`.
- [ ] `CHANGELOG.md`의 `[0.1.0]` 항목이 실제 릴리스 내용과 일치.
- [ ] npm 로그인 상태 확인: `npm whoami` (게시 권한 있는 계정).

## 1. 버전 확인 (게시 전 마지막 관문)

```sh
# 게시될 파일 목록을 실제 게시 없이 미리 본다 (부작용 없음)
npm pack --dry-run -w @terminull/plugin-api
cd packages/cli && npm pack --dry-run && cd -
```

- [ ] `@terminull/plugin-api` 타르볼에 `dist/` + `README.md`만 포함.
- [ ] `terminull` 타르볼에 `dist-pack/` · `web-dist/` · `scripts-pack/` ·
      `README.md`만 포함, bin이 `dist-pack/bin.js`를 가리킴.
- [ ] 어느 쪽에도 소스맵 외 원본 소스·시크릿·`node_modules`가 없음.

## 2. 게시 (순서 고정 · OTP 필요)

**순서: `@terminull/plugin-api` → `terminull`.** 작성 문서가 가리키는 공개
라이브러리를 먼저 올린 뒤 제품 CLI를 올립니다. `<OTP>`는 라율의 인증 앱에서
그 순간 읽은 6자리 TOTP 코드입니다 (memory `kordis-npm-publish-2fa` 패턴).

```sh
# 2-1. 플러그인 API 먼저
npm publish -w @terminull/plugin-api --access public --otp <OTP>

# 2-2. 제품 CLI (tsup prepack이 워크스페이스 코드를 번들)
cd packages/cli && npm publish --access public --otp <OTP> && cd -
```

- [ ] 2-1 성공 → `npm view @terminull/plugin-api version` == `0.1.0`.
- [ ] 2-2 성공 → `npm view terminull version` == `0.1.0`.
- [ ] **게시 직후 라이브 확인** (증거 = 트랜스크립트에 남김):
  ```sh
  # 임시 프리픽스에 실제 설치해 bin이 도는지
  T="$(mktemp -d)"; cd "$T"; npm init -y >/dev/null
  npm install terminull
  ./node_modules/.bin/terminull --help    # exit 0 이어야 함
  node -e "require('node-pty')"            # postinstall 힐링 확인
  cd - && rm -rf "$T"
  ```

## 3. Pack smoke (로컬 재현 — CI와 동일)

```sh
pnpm -r build
cd packages/cli
TARBALL="$(npm pack --silent | tail -n1)"    # tsup prepack이 번들 생성
cd -
git status --porcelain                         # 반드시 비어 있어야 함 (게이트 f)

T="$(mktemp -d)"; cd "$T"; npm init -y >/dev/null
npm install "$OLDPWD/packages/cli/$TARBALL"
./node_modules/.bin/terminull --help           # exit 0
node -e "require('node-pty'); console.log('node-pty ok')"
cd - && rm -rf "$T"
```

## 4. 태그 + GitHub 릴리스

두 패키지가 정상 게시·확인된 뒤에만:

```sh
git tag -a v0.1.0 -m "Terminull v0.1.0 — first public release"
git push origin v0.1.0

gh release create v0.1.0 \
  --title "Terminull v0.1.0" \
  --notes-file docs/release-notes-v0.1.0.md   # 아래 스켈레톤에서 생성
```

### 릴리스 노트 스켈레톤

```md
# Terminull v0.1.0 — 첫 공개 릴리스

모든 CLI 코딩 에이전트를 위한 하나의 패널. `npx terminull setup`으로 시작하세요.

## 하이라이트

- 신뢰 우선 설치: setup이 무엇을 주입하는지 파일 단위로 보여주고, 모든 변경은
  동의 기반 diff 미리보기를 거치며, eject/uninstall이 바이트 단위로 복원합니다.
- 딥 어댑터: Claude Code · Codex. 요약 어댑터: agy. 제네릭 PTY: 임의 CLI.
- 다중 머신(SSH 릴레이), 하네스 편집, 에이전트 승인 인박스, 한/영 i18n.
- 플러그인 작성 키트(@terminull/plugin-api + validate 오라클).

## 설치

    npx terminull setup

## 보안

패널은 감사·거버넌스 계층이지 샌드박스가 아닙니다. 자세한 내용은 SECURITY.md.

## 알려진 한계

- 서비스 관리는 darwin(launchd) 전용. 데스크톱 셸은 서명 없는 로컬 빌드.
- v1.1 백로그: OpenCode 딥 어댑터 · 플러그인 스토어 UI · Windows · 서명 빌드.

전체 변경: CHANGELOG.md
```

- [ ] 태그 `v0.1.0` 푸시됨.
- [ ] GitHub 릴리스 공개, 노트가 CHANGELOG와 일치.

## 5. 롤백 (게시 후 문제 발견 시)

npm은 24시간 이후 unpublish를 사실상 막으므로, **deprecate가 1차 수단**입니다.

```sh
# 5-1. 결함 버전을 deprecate — 설치는 되지만 경고를 띄움
npm deprecate terminull@0.1.0 "결함 있음 — 0.1.1을 사용하세요" --otp <OTP>
npm deprecate @terminull/plugin-api@0.1.0 "결함 있음 — 0.1.1을 사용하세요" --otp <OTP>

# 5-2. 시크릿 유출 등 심각 사고면 72시간 내 unpublish 시도 (정책 제약 있음)
#      npm unpublish terminull@0.1.0 --otp <OTP>
#      실패 시 npm 지원에 조율된 삭제 요청.

# 5-3. 태그/릴리스 되돌리기
gh release delete v0.1.0 --yes
git push --delete origin v0.1.0
git tag -d v0.1.0
```

- [ ] 픽스 버전(`0.1.1`)을 준비해 §0~§4를 다시 밟는 것이 정상 경로.
- [ ] 시크릿이 타르볼에 섞였다면 즉시 회전(rotate) + deprecate + 재게시.

---

## 부록: 왜 이 토폴로지인가 (요약)

- **두 패키지만 공개**: 14개 이름을 유지·보안하는 대신, 제품 CLI는 tsup(esbuild)
  단일 번들로 워크스페이스 코드를 pack 시점에 인라인합니다. 게시 런타임 의존성은
  `node-pty`(네이티브 — external 유지) · `ws` · `zod` 셋뿐입니다.
- **워크스페이스 무변형**: prepack이 생성하는 모든 산출물은
  `packages/cli`의 gitignore된 디렉터리(`dist-pack/` · `web-dist/` ·
  `scripts-pack/`) 안에만 떨어집니다. 그래서 §0의 `git status --porcelain`이
  비어 있어야 합니다.
- **node-pty 힐링**: 게시 패키지는 `scripts-pack/ensure-node-pty.mjs`를 싣고
  `postinstall`로 실행해, 플랫폼 프리빌드가 없으면 소스에서 컴파일합니다.
