#!/usr/bin/env bash
# 현재 브랜치의 커밋된 변경을 Codex CLI(gpt-6.1-sol)로 리뷰한다.
# PASS면 HEAD SHA를 .git/codex-review-passed에 기록하고, require-codex-review 훅은
# 이 기록이 있는 커밋에 대해서만 gh pr create / gh pr merge를 허용한다.
#
# 사용법: .claude/scripts/codex-review.sh [base-branch]   (기본 main)
# 종료 코드: 0 PASS · 1 CHANGES_REQUESTED · 3 리뷰 불가 상태 · 4 codex 실행 실패 · 5 판정 없음
set -euo pipefail

BASE="${1:-main}"
MODEL="${CODEX_REVIEW_MODEL:-gpt-6.1-sol}"
EFFORT="${CODEX_REVIEW_EFFORT:-high}"
# 리뷰어 에이전트의 Bash 호출 제한(10분) 안에 끝나도록 9분으로 둔다.
TIMEOUT_S="${CODEX_REVIEW_TIMEOUT:-540}"

cd "$(git rev-parse --show-toplevel)"

# 리뷰한 내용과 기록되는 SHA가 일치하도록 커밋된 상태만 리뷰한다.
if [ -n "$(git status --porcelain)" ]; then
  echo "커밋되지 않은 변경이 있습니다. 커밋한 뒤 다시 리뷰하세요." >&2
  git status --short >&2
  exit 3
fi
if [ -z "$(git log --oneline "$BASE..HEAD")" ]; then
  echo "$BASE 대비 새 커밋이 없습니다. 리뷰할 변경이 없습니다." >&2
  exit 3
fi

# 리뷰 도중 브랜치가 바뀌어도 리뷰 범위와 기록 SHA가 어긋나지 않게 SHA로 고정한다.
HEAD_SHA="$(git rev-parse HEAD)"
BASE_SHA="$(git merge-base "$BASE" HEAD)"
GIT_DIR="$(git rev-parse --git-common-dir)"
PASSED="$GIT_DIR/codex-review-passed"
OUT_DIR="$GIT_DIR/codex-review"
mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/$HEAD_SHA.md"
LOG="$OUT_DIR/$HEAD_SHA.log"

read -r -d '' PROMPT <<'EOF' || true
이 저장소는 OpenRouter 기반 Chrome MV3 확장(사이드 패널 채팅 에이전트)이다.
구성: src/background(서비스 워커, 에이전트 루프, 도구 디스패처), src/content(페이지 DOM 도구),
src/sidepanel(React UI), src/lib(공용 타입·스키마).

리뷰 대상은 BASE_REF..HEAD_REF 사이의 커밋이다. `git log BASE_REF..HEAD_REF`와 `git diff BASE_REF..HEAD_REF`로 변경을 확인하고,
필요하면 주변 코드를 읽어 맥락을 파악해라(작업 트리는 HEAD_REF와 같다). 파일을 수정하지 마라.

변경 사항을 리뷰해라. 우선순위:
1. 정확성 버그: 경쟁 조건, 중단/재시도 처리, 비동기 오류 누락, 타입과 런타임 불일치
2. 보안: 페이지 콘텐츠를 통한 프롬프트 인젝션으로 민감 동작이 승인 없이 실행되는 경로,
   URL·파일명 검증 누락, API 키 노출
3. 회귀: 기존 도구·메시지 프로토콜·설정과의 호환성
4. MV3 제약: 서비스 워커 수명, content script 주입 시점, 권한
스타일·취향 지적은 하지 않는다.

각 지적 사항은 [P0]~[P3] 심각도, 파일:줄, 실패 시나리오(어떤 입력/상태에서 어떻게 틀리는지)를 적는다.
P0/P1은 머지를 막아야 하는 문제, P2/P3는 권고다.

응답의 마지막 줄은 반드시 다음 중 정확히 하나로 끝낸다:
VERDICT: PASS                (P0/P1이 하나도 없을 때)
VERDICT: CHANGES_REQUESTED   (P0/P1이 하나라도 있을 때)
EOF

PROMPT="${PROMPT//BASE_REF/$BASE_SHA}"
PROMPT="${PROMPT//HEAD_REF/$HEAD_SHA}"

# 이 커밋의 이전 PASS 기록은 이번 리뷰 결과로 대체한다. 재리뷰가 실패하면 통과 상태가 남지 않는다.
revoke_pass() {
  if [ -f "$PASSED" ]; then
    grep -vxF "$HEAD_SHA" "$PASSED" >"$PASSED.tmp" || true
    mv "$PASSED.tmp" "$PASSED"
  fi
}
revoke_pass

echo "[codex-review] $MODEL ($EFFORT) · $BASE..${HEAD_SHA:0:7} 리뷰 중…" >&2
# `codex exec review --base`는 사용자 지침과 함께 쓸 수 없어서 일반 exec에 diff 범위를 지정한다.
# stdin이 열려 있으면 codex가 추가 입력을 기다리며 영원히 멈추므로 /dev/null을 물린다.
# macOS에는 timeout(1)이 없어서 감시 프로세스로 시간 제한을 건다.
codex exec \
  -m "$MODEL" \
  -c "model_reasoning_effort=\"$EFFORT\"" \
  -s read-only \
  -c 'approval_policy="never"' \
  --ephemeral \
  --color never \
  -o "$OUT" \
  "$PROMPT" </dev/null >"$LOG" 2>&1 &
CODEX_PID=$!
( exec 2>/dev/null; sleep "$TIMEOUT_S" && kill "$CODEX_PID" 2>/dev/null && echo "[codex-review] ${TIMEOUT_S}초 초과로 중단" >>"$LOG" ) &
WATCHDOG_PID=$!
CODEX_RC=0
wait "$CODEX_PID" || CODEX_RC=$?
{ pkill -P "$WATCHDOG_PID"; kill "$WATCHDOG_PID"; wait "$WATCHDOG_PID"; } 2>/dev/null || true
if [ "$CODEX_RC" -ne 0 ]; then
  echo "[codex-review] codex 실행 실패 (로그: $LOG)" >&2
  tail -20 "$LOG" >&2
  exit 4
fi

cat "$OUT"
echo

# Codex는 작업 트리도 읽으므로, 리뷰 중 HEAD나 파일이 바뀌었으면 결과를 기록하지 않는다.
if [ "$(git rev-parse HEAD)" != "$HEAD_SHA" ] || [ -n "$(git status --porcelain)" ]; then
  echo "[codex-review] 리뷰 중 HEAD 또는 작업 트리가 바뀌어 결과를 기록하지 않습니다. 다시 리뷰하세요." >&2
  exit 3
fi

VERDICT="$(grep -E '^[[:space:]]*VERDICT:[[:space:]]*(PASS|CHANGES_REQUESTED)[[:space:]]*$' "$OUT" | tail -1 | tr -d '[:space:]' || true)"
case "$VERDICT" in
  VERDICT:PASS)
    echo "$HEAD_SHA" >>"$PASSED"
    echo "[codex-review] PASS — ${HEAD_SHA:0:7} 통과 기록 (전문: $OUT)"
    ;;
  VERDICT:CHANGES_REQUESTED)
    echo "[codex-review] CHANGES_REQUESTED — 지적 사항을 수정·커밋한 뒤 다시 리뷰하세요. (전문: $OUT)"
    exit 1
    ;;
  *)
    echo "[codex-review] 응답에서 VERDICT 줄을 찾지 못했습니다. 통과로 간주하지 않습니다. (전문: $OUT)" >&2
    exit 5
    ;;
esac
