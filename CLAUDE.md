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

## 테스트 메모

- `npm test`는 Node 타입 제거 실행이라 확장자 없는 import가 있는 모듈(`src/lib/schemas.ts` 등)은 불러오지 못한다.
- content script(DOM) 쪽은 자동 테스트 환경이 없다. 확장을 로드해 수동 확인한다.
