#!/usr/bin/env bash
# 현재 브랜치의 커밋된 변경을 Codex CLI(gpt-6.2-astra)로 리뷰한다.
# PASS면 HEAD SHA를 .git/codex-review-passed에 기록하고, require-codex-review 훅은
# 이 기록이 있는 커밋에 대해서만 gh pr create / gh pr merge를 허용한다.
#
# 사용법: .claude/scripts/codex-review.sh [base-branch]   (기본 dev — 기능 브랜치는 dev로 PR한다)
#         .claude/scripts/codex-review.sh [--spec <파일>] [base-branch]
#   --spec <파일>(또는 CODEX_REVIEW_SPEC=<파일>)을 주면 그 파일(이슈의 `확정 사항`)을 프롬프트에 넣는다.
# 종료 코드: 0 PASS · 1 CHANGES_REQUESTED · 3 리뷰 불가 상태 · 4 codex 실행 실패 · 5 판정 없음
set -euo pipefail

# 이슈의 `확정 사항`을 담은 파일(선택). `--spec <파일>` 또는 CODEX_REVIEW_SPEC로 주며, --spec이 우선한다.
# 지정하면 프롬프트에 넣고 범위 밖 제안을 판정에서 뺀다. 둘 다 없으면 예전과 같다.
SPEC_SET=0
SPEC_FILE=""
if [ -n "${CODEX_REVIEW_SPEC+x}" ]; then
  SPEC_SET=1
  SPEC_FILE="$CODEX_REVIEW_SPEC"
fi
BASE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --spec)
      # 값이 없으면 빈 경로로 두어 아래에서 이전 PASS를 지운 뒤 멈추게 한다.
      SPEC_SET=1
      SPEC_FILE="${2:-}"
      shift $(( $# < 2 ? 1 : 2 ))
      ;;
    *)
      if [ -n "$BASE" ]; then
        echo "base 브랜치는 하나만 줄 수 있습니다: $BASE, $1" >&2
        exit 3
      fi
      BASE="$1"
      shift
      ;;
  esac
done
BASE="${BASE:-dev}"
MODEL="${CODEX_REVIEW_MODEL:-gpt-6.2-astra}"
EFFORT="${CODEX_REVIEW_EFFORT:-high}"
# 리뷰어 에이전트의 Bash 호출 제한(10분) 안에 끝나도록 9분으로 둔다.
TIMEOUT_S="${CODEX_REVIEW_TIMEOUT:-540}"

# 상대 경로는 호출한 위치 기준이므로 저장소 루트로 옮기기 전에 절대 경로로 바꿔 둔다.
# 파일 검사는 이전 PASS 기록을 지운 뒤에 한다(아래 revoke_pass 다음). 확정 사항 파일은 저장소 밖에 둔다
# (안에 두면 미커밋 변경으로 보여 리뷰가 시작되지 않는다).
# PASS 기록은 "이 SHA가 리뷰를 통과했다"만 남기는 절차 가드이고 확정 사항 여부를 구분하지 않는다(기록 방식은
# 바꾸지 않는다). 확정 사항 없이 받은 PASS는 [범위 밖] 면제가 없는 리뷰라 확정 사항을 준 리뷰보다 느슨하지 않으므로,
# 확정 사항을 준 재리뷰가 잠금·미커밋 변경 등으로 시작 전에 멈췄을 때 같은 SHA의 이전 PASS가 남아도 허용한다.
if [ -n "$SPEC_FILE" ] && [ "${SPEC_FILE#/}" = "$SPEC_FILE" ]; then
  SPEC_FILE="$PWD/$SPEC_FILE"
fi

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
# 기능 PR은 원격 dev로 머지되므로 origin/dev 대비 전체 범위를 리뷰했을 때만 통과를 기록한다.
# 로컬 dev에 미푸시 커밋이 있으면 그만큼 리뷰에서 빠지므로 로컬 브랜치를 기준으로 쓰지 않는다.
RECORD=0
if [ "$BASE" = "dev" ]; then
  # single-branch clone에도 origin/dev가 생기도록 목적지를 명시한다.
  if ! git fetch -q origin "+refs/heads/dev:refs/remotes/origin/dev"; then
    echo "origin dev를 가져오지 못했습니다. 네트워크를 확인한 뒤 다시 실행하세요." >&2
    exit 3
  fi
  BASE="origin/dev"
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
5. 프로젝트 구현 규칙: 코드에 낱말·문구 목록이나 정규식을 두고 뜻을 추론해 승인을 면제하거나
   동작을 바꾸는 구현(예: /(주문\s*내역|order\s*history)/로 조회 링크를 판정해 승인을 건너뜀)은 P1이다.
   예외·허용은 구조(요소 종류, 주소 출처·형태, 양식 관계)나 사용자의 명시적 선택으로만 만들어야 한다.
   결제·개인정보를 의심해 더 묻게만 하는 기존 키워드 신호는 허용한다.
스타일·취향 지적은 하지 않는다.

위협 모델(.claude/ 아래 훅·리뷰 스크립트 변경에 적용): 이 도구들은 Claude Code 에이전트가 리뷰를
빠뜨리거나 리뷰 후 커밋을 추가한 채 PR을 올리는 실수를 막는 절차 가드다. 다음은 범위 밖이므로
P2 이하로만 분류한다: 셸 접근 권한자의 의도적 우회, 다른 작업자의 동시 push로 인한 검사-실행 사이 경쟁,
Claude Code 훅 실행기 자체의 장애·타임아웃. 에이전트가 평범하게 쓰는 명령에서 게이트가 잘못 열리거나
정상 작업이 막히는 문제는 범위 안이다.
EOF

read -r -d '' PROMPT_SEVERITY <<'EOF' || true
각 지적 사항은 [P0]~[P3] 심각도, 파일:줄, 실패 시나리오(어떤 입력/상태에서 어떻게 틀리는지)를 적는다.
P0/P1은 머지를 막아야 하는 문제, P2/P3는 권고다.
EOF

read -r -d '' PROMPT_VERDICT <<'EOF' || true
응답의 마지막 줄은 반드시 다음 중 정확히 하나로 끝낸다:
VERDICT: PASS                (P0/P1이 하나도 없을 때)
VERDICT: CHANGES_REQUESTED   (P0/P1이 하나라도 있을 때)
EOF

PROMPT="${PROMPT//BASE_REF/$BASE_SHA}"
PROMPT="${PROMPT//HEAD_REF/$HEAD_SHA}"
PROMPT="$PROMPT"$'\n\n'"$PROMPT_SEVERITY"

# 이 커밋의 이전 PASS 기록은 이번 리뷰 결과로 대체한다. 재리뷰가 실패하면 통과 상태가 남지 않는다.
revoke_pass() {
  if [ -f "$PASSED" ]; then
    grep -vxF "$HEAD_SHA" "$PASSED" >"$PASSED.tmp" || true
    mv "$PASSED.tmp" "$PASSED"
  fi
}
revoke_pass

# 확정 사항 파일은 PASS 기록을 지운 뒤 검사한다. 지정했는데(빈 값 포함) 못 읽거나 비어 있으면
# 명세 없이 리뷰하지 않고 리뷰 불가(3)로 멈춘다.
# 내용은 치환·eval 없이 문자열 그대로 이어 붙인다(따옴표·줄바꿈·BASE_REF 같은 글자도 그대로 전달).
# 심각도 형식 지시 뒤에 두어 [범위 밖] 규칙이 그 지시를 덮게 한다.
if [ "$SPEC_SET" = 1 ]; then
  if [ -z "$SPEC_FILE" ]; then
    echo "확정 사항 파일 경로가 비어 있습니다(--spec 또는 CODEX_REVIEW_SPEC)." >&2
    exit 3
  fi
  if [ ! -f "$SPEC_FILE" ] || [ ! -r "$SPEC_FILE" ]; then
    echo "확정 사항 파일을 읽을 수 없습니다: $SPEC_FILE" >&2
    exit 3
  fi
  if ! SPEC_TEXT="$(cat -- "$SPEC_FILE")"; then
    echo "확정 사항 파일을 읽다가 실패했습니다: $SPEC_FILE" >&2
    exit 3
  fi
  # 공백 아닌 글자가 하나라도 있는지만 본다(${var//...} 치환은 bash 3.2에서 긴 한글 글자에 매우 느리다).
  if [[ ! "$SPEC_TEXT" =~ [^[:space:]] ]]; then
    echo "확정 사항 파일이 비어 있습니다: $SPEC_FILE" >&2
    exit 3
  fi
  read -r -d '' SPEC_RULE <<'EOF' || true
위 확정 사항은 관리자가 이 작업의 범위로 정한 고정 명세다. 판정 규칙(위 심각도 형식보다 우선한다):
- 확정 사항 밖의 범위 확장 제안("X도 해야 한다", "이렇게 하면 더 낫다")은 [P0]~[P3]을 붙이지 않고 [범위 밖]으로 표시한다.
  [범위 밖]은 P0/P1이 아니며 VERDICT에 영향을 주지 않는다(별도 이슈로 뺀다).
- 정확성·보안·회귀 결함("이 경로에서 틀린다")은 확정 사항 안팎과 관계없이 원래 심각도로 분류한다. [범위 밖]으로 내리지 않는다.
- VERDICT는 [범위 밖]을 빼고 P0/P1 결함만 세어 정한다.
EOF
  PROMPT="$PROMPT"$'\n\n## 확정 사항\n\n'"$SPEC_TEXT"$'\n\n'"$SPEC_RULE"
  echo "[codex-review] 확정 사항 포함: $SPEC_FILE" >&2
fi
PROMPT="$PROMPT"$'\n\n'"$PROMPT_VERDICT"

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
      echo "[codex-review] PASS — base가 dev가 아니라 통과 기록은 남기지 않습니다. PR 전에는 dev 대비로 다시 리뷰하세요. (전문: $OUT)"
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
