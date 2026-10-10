#!/usr/bin/env bash
# PreToolUse(Bash) 훅: gh pr create / gh pr merge 전에 해당 커밋의 Codex 리뷰 통과 기록을 요구한다.
# 기록은 .claude/scripts/codex-review.sh가 PASS일 때만 남긴다. 종료 코드 2면 명령이 차단된다.
input="$(cat)"
cmd="$(jq -r '.tool_input.command // ""' <<<"$input")"
cwd="$(jq -r '.cwd // ""' <<<"$input")"

# 명령 위치(맨 앞, ; && || | ( $( 줄바꿈 뒤)에 있는 gh pr create/merge만 잡는다.
# 커밋 메시지·PR 본문 문자열 안의 "gh pr create"까지 막으면 안 된다.
nl=$'\n'
pattern="(^|[;&|(${nl}])[[:space:]]*gh[[:space:]]+pr[[:space:]]+(create|merge)([[:space:]]|$)"
[[ "$cmd" =~ $pattern ]] || exit 0
action="${BASH_REMATCH[2]}"

cd "${CLAUDE_PROJECT_DIR:-$cwd}" 2>/dev/null || exit 0

if [ "$action" = "create" ]; then
  sha="$(git rev-parse HEAD 2>/dev/null)"
else
  # gh pr merge <번호> 또는 현재 브랜치의 PR. PR의 head 커밋이 리뷰된 커밋이어야 한다.
  num="$(grep -oE 'gh[[:space:]]+pr[[:space:]]+merge[[:space:]]+[0-9]+' <<<"$cmd" | head -1 | grep -oE '[0-9]+$')"
  sha="$(gh pr view $num --json headRefOid -q .headRefOid 2>/dev/null)"
fi

passed="$(git rev-parse --git-common-dir 2>/dev/null)/codex-review-passed"
if [ -n "$sha" ] && [ -f "$passed" ] && grep -qx "$sha" "$passed"; then
  exit 0
fi

echo "차단: 커밋 ${sha:-(확인 불가)}에 대한 Codex 리뷰 통과 기록이 없습니다. codex-reviewer 에이전트로 리뷰를 받아 PASS한 뒤 다시 시도하세요. 리뷰 후 커밋을 추가했다면 다시 리뷰해야 합니다." >&2
exit 2
