# 기여 안내

버그 신고, 제안, 코드 기여 모두 환영합니다. 버그와 제안은 [이슈 양식](https://github.com/ingki3/simple-browser-plugin/issues/new/choose)으로 남겨 주세요.

## 개발 환경

Node.js 22와 Chrome이 필요합니다.

```bash
git clone https://github.com/ingki3/simple-browser-plugin.git
cd simple-browser-plugin
npm ci
npm run build        # dist/ 생성 → chrome://extensions에서 "압축해제된 확장 프로그램 로드"
```

| 명령 | 하는 일 |
|---|---|
| `npm run dev` | Vite 개발 서버(HMR) |
| `npm run build` | 프로덕션 빌드 → `dist/` |
| `npm run typecheck` | 타입 검사 |
| `npm test` | 단위 테스트(Node 타입 제거 실행, `tests/*.test.mjs`) |
| `npm run harness [이름 일부]` | 확장 하네스: 빌드한 `dist`를 Chrome for Testing에 올려 실제 사이드 패널을 조작(먼저 `npm run build`) |

- 하네스(`tests/harness/`)는 로컬 시험 서버 두 개(서로 다른 출처)와 모의 모델로 승인 규칙, 클릭·입력, 손 넘기기, 저장 링크, 입력값 보호를 확인합니다.
  - Chrome은 `HARNESS_CHROME` 또는 Playwright 캐시에서 찾습니다(`npx playwright-core install chromium`).
  - 화면을 보려면 `HARNESS_HEADED=1`을 씁니다.
- `npm test`는 Node의 타입 제거 실행이라, 확장자 없는 import가 있는 모듈은 불러오지 못합니다. 순수 로직은 `src/lib/`에 두고 상대 경로에 `.ts`를 붙여 가져옵니다.
- 실제 사이트의 동작(봇 차단, 사이트 구조)은 하네스로 다 볼 수 없으니, 확장을 불러와 직접 확인합니다.

구조는 [docs/architecture.md](docs/architecture.md), 기능별 규칙은 [docs/features.md](docs/features.md)를 보세요.

## 지켜야 할 규칙

- **키워드로 승인을 건너뛰지 않습니다.** 낱말 목록이나 정규식으로 뜻을 짐작해 승인을 면제하거나 동작을 바꾸면 안 됩니다. 공격자가 그 낱말만 넣으면 통과하기 때문입니다.
  - 예외는 구조(요소 종류, 주소의 출처와 형태, 양식 관계)나 사용자의 명시적 선택으로만 만듭니다.
  - 낱말은 **더 묻는 쪽**(결제·개인정보·삭제 의심 신호)으로만 씁니다.
- **화면 글자는 보내고, 사용자가 입력한 값은 보호합니다.** 찾기·실행 도구(`find_*`, `fill_form_fields`, `click_element`, `query_dom`)의 결과와 오류에는 입력칸의 값과 편집 영역의 글자를 넣지 않습니다. 모델로 가는 글자는 `src/content/modelText.ts`로 만듭니다.
- 특정 사이트만을 위한 예외 코드는 넣지 않습니다. 사이트와 관계없이 동작하는 일반 기능으로 만듭니다.
- 봇 탐지를 피하는 기능은 받지 않습니다. 자동화를 막는 사이트는 "직접 조작할 사이트"(손 넘기기)로 처리합니다.
- 화면 문구는 쉬운 한국어로, 하는 일과 다음 행동이 드러나게 씁니다. 내부 도구 이름이나 이슈 번호는 화면에 보이지 않게 합니다.

## PR 절차

1. 저장소를 fork하고, `dev`에서 브랜치를 만듭니다(`git checkout -b feat/your-change origin/dev`).
2. 고친 뒤 `npm test`, `npm run typecheck`, `npm run build`를 통과시킵니다.
   - content script, 승인 판정, 도구 결과를 바꿨다면 `npm run harness`도 돌립니다.
   - 새 동작에는 `tests/harness/scenarios/`에 시나리오를 더합니다.
3. **`dev` 대상**으로 PR을 엽니다. 무엇을 왜 바꿨는지와 어떻게 확인했는지 적어 주세요. CI(단위 테스트·타입 검사·빌드)를 통과해야 합니다.
4. 관리자가 리뷰한 뒤 squash로 머지합니다. 릴리스는 `dev` → `main` PR로 묶어 내고, main에 `vX.X.XX` 태그를 달면 설치용 ZIP이 Releases에 올라갑니다.

버전 형식은 `X.X.XX`이며, 릴리스마다 수정 번호를 1 올립니다. `package.json`, `package-lock.json`, `manifest.config.ts`를 함께 바꿉니다. 기능 PR에서는 올리지 않아도 됩니다.
