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

# 리뷰 도중 브랜치가 바뀌어도 리뷰 범위와 기록 SHA가 어긋나지 않게 SHA로 고정한다.
HEAD_SHA="$(git rev-parse HEAD)"
GIT_DIR="$(git rev-parse --git-common-dir)"
PASSED="$GIT_DIR/codex-review-passed"
# PR은 원격 main으로 머지되므로 origin/main 대비 전체 범위를 리뷰했을 때만 통과를 기록한다.
# 로컬 main에 미푸시 커밋이 있으면 그만큼 리뷰에서 빠지므로 로컬 브랜치를 기준으로 쓰지 않는다.
RECORD=0
if [ "$BASE" = "main" ]; then
  # single-branch clone에도 origin/main이 생기도록 목적지를 명시한다.
  if ! git fetch -q origin "+refs/heads/main:refs/remotes/origin/main"; then
    echo "origin main을 가져오지 못했습니다. 네트워크를 확인한 뒤 다시 실행하세요." >&2
    exit 3
  fi
  BASE="origin/main"
  RECORD=1
fi
BASE_SHA="$(git merge-base "$BASE" HEAD)"
if [ -z "$(git log --oneline "$BASE_SHA..HEAD")" ]; then
  echo "$BASE 대비 새 커밋이 없습니다. 리뷰할 변경이 없습니다." >&2
  exit 3
fi

# 같은 저장소에서 리뷰가 겹치면 통과 기록 갱신이 꼬이므로 한 번에 하나만 실행한다.
LOCK="$GIT_DIR/codex-review.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "다른 Codex 리뷰가 실행 중입니다. 끝난 뒤 다시 실행하세요. (멈춘 실행이 남긴 것이면 $LOCK 삭제)" >&2
  exit 3
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

# pid와 모든 자손 프로세스를 TERM으로 끝내고, 3초 안에 안 끝나면 KILL한다.
descendants() {
  local child
  for child in $(pgrep -P "$1" 2>/dev/null); do
    echo "$child"
    descendants "$child"
  done
}
kill_tree() {
  local pids i
  pids="$1 $(descendants "$1")"
  kill -TERM $pids 2>/dev/null
  for i in $(seq 15); do
    kill -0 $pids 2>/dev/null || return 0
    sleep 0.2
  done
  kill -KILL $pids 2>/dev/null
  return 0
}

# 중단되면 codex와 감시 프로세스를 먼저 끝내고 lock을 푼다. 남은 codex가 같은 결과 파일을 덮어쓰지 않게.
on_signal() {
  set +e  # 정리 명령이 실패해도(자식 없음 등) 끝까지 진행한다.
  [ -n "${WATCHDOG_PID:-}" ] && kill_tree "$WATCHDOG_PID"
  if [ -n "${CODEX_PID:-}" ]; then
    kill_tree "$CODEX_PID"
    wait "$CODEX_PID" 2>/dev/null
  fi
  exit 4
}
trap on_signal INT TERM
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

위협 모델(.claude/ 아래 훅·리뷰 스크립트 변경에 적용): 이 도구들은 Claude Code 에이전트가 리뷰를
빠뜨리거나 리뷰 후 커밋을 추가한 채 PR을 올리는 실수를 막는 절차 가드다. 다음은 범위 밖이므로
P2 이하로만 분류한다: 셸 접근 권한자의 의도적 우회, 다른 작업자의 동시 push로 인한 검사-실행 사이 경쟁,
Claude Code 훅 실행기 자체의 장애·타임아웃. 에이전트가 평범하게 쓰는 명령에서 게이트가 잘못 열리거나
정상 작업이 막히는 문제는 범위 안이다.

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
TIMED_OUT="$OUT_DIR/.timed-out.$$"
rm -f "$TIMED_OUT"
( exec 2>/dev/null; trap - INT TERM; set +e
  sleep "$TIMEOUT_S" || exit 0
  : >"$TIMED_OUT"
  echo "[codex-review] ${TIMEOUT_S}초 초과로 중단" >>"$LOG"
  kill_tree "$CODEX_PID" ) &
WATCHDOG_PID=$!
CODEX_RC=0
wait "$CODEX_PID" || CODEX_RC=$?
if [ -e "$TIMED_OUT" ]; then
  # 타임아웃 정리(TERM 후 KILL)가 끝날 때까지 기다린 뒤 진행한다. 중간에 끊으면 자손이 살아남는다.
  wait "$WATCHDOG_PID" 2>/dev/null || true
  rm -f "$TIMED_OUT"
else
  { pkill -P "$WATCHDOG_PID"; kill "$WATCHDOG_PID"; wait "$WATCHDOG_PID"; } 2>/dev/null || true
fi
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

# 판정은 응답의 마지막 비어 있지 않은 줄만 인정한다. 본문 중간의 예시 문구는 무시한다.
LAST_LINE="$(awk 'NF { last = $0 } END { print last }' "$OUT")"
VERDICT=""
if [[ "$LAST_LINE" =~ ^[[:space:]]*VERDICT:[[:space:]]*(PASS|CHANGES_REQUESTED)[[:space:]]*$ ]]; then
  VERDICT="VERDICT:${BASH_REMATCH[1]}"
fi
case "$VERDICT" in
  VERDICT:PASS)
    if [ "$RECORD" = 1 ]; then
      echo "$HEAD_SHA" >>"$PASSED"
      echo "[codex-review] PASS — ${HEAD_SHA:0:7} 통과 기록 (전문: $OUT)"
    else
      echo "[codex-review] PASS — base가 main이 아니라 통과 기록은 남기지 않습니다. PR 전에는 main 대비로 다시 리뷰하세요. (전문: $OUT)"
    fi
    ;;
  VERDICT:CHANGES_REQUESTED)
    echo "[codex-review] CHANGES_REQUESTED — 지적 사항을 수정·커밋한 뒤 다시 리뷰하세요. (전문: $OUT)"
    exit 1
    ;;
  *)
    echo "[codex-review] 응답의 마지막 줄이 VERDICT 형식이 아닙니다. 통과로 간주하지 않습니다. (전문: $OUT)" >&2
    exit 5
    ;;
esac
