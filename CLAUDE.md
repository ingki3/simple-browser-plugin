# 간편 브라우저 도우미 (simple-browser-plugin)

OpenRouter 기반 Chrome MV3 사이드 패널 에이전트. 구조와 기능은 README.md 참고.

## 개발 워크플로 (필수)

1. `main`은 보호 브랜치다. feature branch에서 작업한다.
2. 변경 후 `npm test`, `npm run typecheck`, `npm run build`를 통과시킨다.
3. 커밋한다. 리뷰는 커밋된 상태만 대상으로 한다.
4. **`codex-reviewer` 에이전트로 리뷰를 받는다.** (Codex CLI, gpt-6.1-sol)
   - CHANGES_REQUESTED면 P0/P1을 고치고 커밋한 뒤 다시 리뷰한다. PASS까지 반복한다.
   - P2/P3 권고는 반영하거나, 반영하지 않으면 PR 본문에 이유를 적는다.
   - 리뷰 후 커밋을 추가하면 그 커밋은 다시 리뷰해야 한다.
5. PASS 후 push하고 PR을 만든다. PR 본문에 리뷰 결과(PASS, 반영한 지적 사항)를 적는다.

`gh pr create` / `gh pr merge`는 `.claude/hooks/require-codex-review.py` 훅이 리뷰 통과 기록
(`.git/codex-review-passed`)이 없는 커밋에 대해 차단한다. 훅을 우회하지 않는다.
훅은 Claude가 리뷰를 빠뜨리는 실수를 막는 절차 가드다(의도적 우회 방지는 GitHub 브랜치 보호의 몫).
셸을 해석하지 않고 허용 목록으로 검사하므로, 명령 어디든 `gh`와 `pr`이 보이면 다음 형식만 통과한다.

- 다른 명령과 묶지 않고 단독 실행(`&&`, `;`, `|`, `$`, 백틱, `bash -c`, `eval`, `gh -R`/`gh pr -R` 불가).
- 생성: PASS한 커밋을 push한 뒤 `gh pr create --base main --head <브랜치> --title … --body-file …`.
  origin의 그 브랜치 SHA가 PASS 기록과 같아야 한다.
- 머지: `gh pr merge <번호> --squash --match-head-commit <PASS한 전체 SHA>`. PR base는 main이어야 한다.
  `--auto`, `--admin`은 불가. PR이 바로 머지 가능(CLEAN)하고 main에 merge queue가 없어야 한다.
- 옵션은 허용 목록에 있는 것만, 붙여 쓰지 않고(`-Hx`, `-fH` 불가), 한 번씩만 쓴다.
- `gh pr view/list/status/checks/diff/edit/comment/close/reopen/ready`는 단독 실행이면 통과한다.
- 커밋 메시지에 `gh`와 `pr`이 함께 들어가면 차단되므로 `git commit -F <파일>`로 넘긴다.
- 통과 기록은 main 대비 리뷰에서만 남는다. 리뷰는 한 번에 하나만 실행된다.

리뷰를 직접 돌리려면: `.claude/scripts/codex-review.sh [base]` (기본 main).
모델·추론 강도·시간 제한은 `CODEX_REVIEW_MODEL`, `CODEX_REVIEW_EFFORT`, `CODEX_REVIEW_TIMEOUT`
환경변수로 바꿀 수 있다(기본 gpt-6.1-sol, high, 540초).

## 버전 관리

- 형식은 `X.X.XX`(주.부.수정). 수정 번호는 0~99이고 앞자리를 0으로 채우지 않는다(Chrome manifest가 `0.1.03`을 거부한다).
  99 다음은 부 번호를 올리고 수정 번호를 0으로 한다(`0.1.99` → `0.2.0`).
- main에 머지하는 PR마다 수정 번호를 1 올린다(같은 PR에서 `package.json`·`package-lock.json`·`manifest.config.ts`를 함께).
  `tests/version.test.mjs`가 세 곳이 같고 형식이 맞는지 확인한다.
- 큰 기능 묶음이나 호환이 깨지는 변경은 사용자와 정해 부·주 번호를 올린다.
- 머지 뒤 main의 머지 커밋에 `vX.X.XX` 태그를 달고 push한다.

## 구현 규칙

- **키워드 매칭으로 승인을 면제하거나 동작을 바꾸지 않는다.** 코드에 낱말·문구 목록이나 정규식을 두고
  "이 글자면 조회 링크다"처럼 뜻을 추론해 승인을 건너뛰거나 동작을 바꾸는 구현은 금지한다.
  우회가 쉽다(공격자가 그 낱말만 넣으면 통과). 예외·허용은 구조(요소 종류, 주소의 출처·형태, 양식 관계)나
  사용자의 명시적 선택으로만 만든다.
- 이미 있는 결제·개인정보 의심 신호(`src/lib/autoApprove.ts`의 `PAYMENT_TEXT_RE` 등)처럼 **더 묻는 쪽**으로만
  쓰는 키워드는 허용한다. 잘못 걸려도 승인 카드가 한 번 더 뜰 뿐이다. 새 키워드 목록을 늘리기 전에 구조로
  판단할 수 있는지 먼저 본다.
- **화면 글자는 보내고, 사용자가 입력한 값은 보호한다**(#43 사용자 결정). 이 탭에서 도우미를 쓰는 것을 지금 페이지의
  화면 글자(라벨·버튼 글자·select 선택지 글자·행 문맥처럼 페이지가 만든 글자)를 모델에 보내는 동의로 본다. 입력 칸의 값과
  편집 영역의 글자는 찾기·실행 도구(`find_*`·`fill_form_fields`·`click_element`·`query_dom`)의 결과·오류 어디에도 넣지 않는다.
  모델로 가는 글자는 `src/content/modelText.ts`로 만들고, 판정은 구조(요소 종류·편집 가능 여부·표시 여부)로만 한다.
- 뜻 판단이 필요한 일(어느 링크가 배송 조회로 가는지)은 모델이 지침과 관측으로 하고, 코드는 모델이 넘긴
  값을 그대로 쓰는 일반 기능(예: `find_clickables` query 필터)만 제공한다.

## 테스트 메모

- `npm test`는 Node 타입 제거 실행이라 확장자 없는 import가 있는 모듈(`src/lib/schemas.ts` 등)은 불러오지 못한다.
- content script(DOM) 쪽은 자동 테스트 환경이 없다. 확장을 로드해 수동 확인한다.
