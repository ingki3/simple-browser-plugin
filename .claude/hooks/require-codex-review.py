#!/usr/bin/env python3
"""PreToolUse(Bash) 훅: gh pr create / gh pr merge 전에 대상 커밋의 Codex 리뷰 통과 기록을 요구한다.

기록(.git/codex-review-passed)은 .claude/scripts/codex-review.sh가 PASS일 때만 남긴다.
셸 구문을 완전히 해석하는 대신, gh pr create/merge가 보이면 검사 가능한 단독 형식만 허용한다.

- gh pr merge: 단독 명령 + --match-head-commit <PASS한 SHA>. gh가 실행 시점에 head를 고정한다.
- gh pr create: 단독 명령, -R/--repo 없음. 원격 브랜치(--head 또는 현재 브랜치)의 SHA가 PASS여야 한다.

종료 코드 2면 명령이 차단된다.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys

SEPARATORS = set(";&|()`\n")
# 따옴표·치환 안에 숨은 것까지 포함해 원문에서 gh ... pr ... create|merge 흔적을 찾는다.
LOOSE = re.compile(r"\bgh\b.*\bpr\b.*\b(create|merge)\b", re.S)

USAGE = (
    "gh pr create / gh pr merge는 다른 명령과 묶지 말고 단독으로 실행하세요"
    " (&&, ;, |, $(...), gh 전역 옵션 불가).\n"
    "  머지: gh pr merge <번호> --squash --match-head-commit <Codex PASS한 SHA>\n"
    "  생성: 리뷰 통과 커밋을 push한 뒤 gh pr create ... (-R/--repo 불가)"
)


def split_commands(cmd: str) -> list[list[str]]:
    """셸 명령 문자열을 명령 단위의 단어 목록으로 나눈다(인용부호 안의 구분자는 무시)."""
    commands: list[list[str]] = []
    words: list[str] = []
    word: list[str] = []
    in_word = False
    quote = ""
    i = 0
    while i < len(cmd):
        c = cmd[i]
        if quote:
            if c == quote:
                quote = ""
            elif c == "\\" and quote == '"' and i + 1 < len(cmd):
                i += 1
                word.append(cmd[i])
            else:
                word.append(c)
        elif c in "'\"":
            quote = c
            in_word = True
        elif c == "\\" and i + 1 < len(cmd):
            i += 1
            if cmd[i] != "\n":
                word.append(cmd[i])
                in_word = True
        elif c.isspace() and c != "\n":
            if in_word:
                words.append("".join(word))
                word, in_word = [], False
        elif c in SEPARATORS:
            if in_word:
                words.append("".join(word))
                word, in_word = [], False
            if words:
                commands.append(words)
            words = []
        else:
            word.append(c)
            in_word = True
        i += 1
    if in_word:
        words.append("".join(word))
    if words:
        commands.append(words)
    return commands


def mentions_pr_op(cmd: str, commands: list[list[str]]) -> bool:
    """gh pr create/merge가 실행될 수 있는 명령인가. 판단이 애매하면 True(검사 대상)."""
    for words in commands:
        if any(os.path.basename(w) == "gh" for w in words) and "pr" in words and (
            "create" in words or "merge" in words
        ):
            return True
    # 큰따옴표 안의 $(...)나 백틱은 위 파서가 문자열로 취급하므로 원문으로 한 번 더 본다.
    return ("$(" in cmd or "`" in cmd) and bool(LOOSE.search(cmd))


def flag_value(args: list[str], short: str, long: str) -> str | None:
    """-X v, -Xv, --long v, --long=v 모두 인식한다."""
    for i, a in enumerate(args):
        if a in (short, long):
            return args[i + 1] if i + 1 < len(args) else ""
        if a.startswith(long + "="):
            return a[len(long) + 1:]
        if a.startswith(short) and not a.startswith("--") and len(a) > len(short):
            return a[len(short):]
    return None


def run(cmd: list[str]) -> str:
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return r.stdout.strip() if r.returncode == 0 else ""


def remote_branch_sha(branch: str) -> str:
    out = run(["git", "ls-remote", "origin", f"refs/heads/{branch}"])
    return out.split()[0] if out else ""


def check(action: str, args: list[str], passed: set[str]) -> str | None:
    """통과면 None, 아니면 차단 사유."""
    if action == "merge":
        sha = flag_value(args, "--match-head-commit", "--match-head-commit")
        if not sha:
            return "gh pr merge에 --match-head-commit <리뷰 통과 SHA>가 없습니다."
        if sha not in passed:
            return f"--match-head-commit {sha}는 Codex 리뷰 통과 기록이 없는 커밋입니다."
        return None

    if flag_value(args, "-R", "--repo") is not None:
        return "gh pr create의 -R/--repo는 허용하지 않습니다(대상 커밋을 확인할 수 없음)."
    head = flag_value(args, "-H", "--head")
    if head is not None and ":" in head:
        return f"--head {head}: 다른 저장소의 브랜치는 확인할 수 없습니다."
    branch = head or run(["git", "symbolic-ref", "--quiet", "--short", "HEAD"])
    if not branch:
        return "현재 브랜치를 확인할 수 없습니다(detached HEAD)."
    remote = remote_branch_sha(branch)
    if not remote:
        return f"origin/{branch}가 없습니다. 리뷰 통과 커밋을 먼저 push하세요."
    if head is None and remote != run(["git", "rev-parse", "HEAD"]):
        return f"origin/{branch}({remote[:7]})가 로컬 HEAD와 다릅니다. push 상태를 맞춘 뒤 다시 실행하세요."
    if remote not in passed:
        return f"origin/{branch}({remote[:7]})는 Codex 리뷰 통과 기록이 없는 커밋입니다."
    return None


def main() -> int:
    data = json.load(sys.stdin)
    cmd = (data.get("tool_input") or {}).get("command") or ""
    commands = split_commands(cmd)
    if not mentions_pr_op(cmd, commands):
        return 0

    def block(reason: str) -> int:
        print(f"차단: {reason}\n{USAGE}\n리뷰는 codex-reviewer 에이전트로 받으세요.", file=sys.stderr)
        return 2

    # 단독 표준형만 허용: 명령 하나, gh pr <action>으로 시작, 명령 치환 없음.
    if (
        len(commands) != 1
        or "$(" in cmd
        or "`" in cmd
        or len(commands[0]) < 3
        or commands[0][0] != "gh"
        or commands[0][1] != "pr"
        or commands[0][2] not in ("create", "merge")
    ):
        return block("검사할 수 없는 형식의 gh pr create/merge 명령입니다.")

    project = os.environ.get("CLAUDE_PROJECT_DIR") or data.get("cwd") or "."
    try:
        os.chdir(project)
    except OSError:
        pass
    passed: set[str] = set()
    git_dir = run(["git", "rev-parse", "--git-common-dir"])
    if git_dir:
        try:
            with open(os.path.join(git_dir, "codex-review-passed")) as f:
                passed = {line.strip() for line in f if line.strip()}
        except OSError:
            pass

    reason = check(commands[0][2], commands[0][3:], passed)
    return block(reason) if reason else 0


if __name__ == "__main__":
    sys.exit(main())
