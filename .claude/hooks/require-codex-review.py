#!/usr/bin/env python3
"""PreToolUse(Bash) 훅: gh pr create / gh pr merge 전에 대상 커밋의 Codex 리뷰 통과 기록을 요구한다.

기록(.git/codex-review-passed)은 .claude/scripts/codex-review.sh가 PASS일 때만 남긴다.
한 호출에 들어 있는 모든 gh pr create/merge를 검사하고, 대상 커밋을 확인할 수 없으면 차단한다.
종료 코드 2면 명령이 차단된다.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys

SEPARATORS = set(";&|()`\n")

# 값을 받는 플래그. 이 뒤의 단어는 위치 인자(PR 번호·URL·브랜치)가 아니다.
MERGE_VALUE_FLAGS = {
    "-b", "--body", "-F", "--body-file", "-t", "--subject",
    "-A", "--author-email", "--match-head-commit", "-R", "--repo",
}


def split_commands(cmd: str) -> list[list[str]]:
    """셸 명령 문자열을 명령 단위의 단어 목록으로 나눈다.

    인용부호 안의 ; | & 줄바꿈은 구분자로 보지 않는다. 히어독 본문 등은 명령으로 볼 수 있는데,
    그 경우 오탐으로 차단되는 쪽(안전한 쪽)으로 실패한다.
    """
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


def find_pr_ops(commands: list[list[str]]) -> list[tuple[str, list[str]]]:
    """(create|merge, 그 뒤 인자들) 목록. env·command 같은 접두어가 있어도 잡는다."""
    ops = []
    for words in commands:
        for i in range(len(words) - 2):
            if (
                os.path.basename(words[i]) == "gh"
                and words[i + 1] == "pr"
                and words[i + 2] in ("create", "merge")
            ):
                ops.append((words[i + 2], words[i + 3:]))
                break
    return ops


def flag_value(args: list[str], names: tuple[str, ...]) -> str | None:
    for i, a in enumerate(args):
        for n in names:
            if a == n and i + 1 < len(args):
                return args[i + 1]
            if n.startswith("--") and a.startswith(n + "="):
                return a[len(n) + 1:]
    return None


def merge_target(args: list[str]) -> str | None:
    skip = False
    for a in args:
        if skip:
            skip = False
            continue
        if a in MERGE_VALUE_FLAGS:
            skip = True
            continue
        if a.startswith("-"):
            continue
        return a
    return None


def run(cmd: list[str]) -> str:
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return r.stdout.strip() if r.returncode == 0 else ""


def target_sha(action: str, args: list[str]) -> tuple[str, str]:
    """(검사할 커밋 SHA, 설명). 확인할 수 없으면 SHA는 빈 문자열."""
    repo = flag_value(args, ("-R", "--repo"))
    if action == "create":
        head = flag_value(args, ("-H", "--head"))
        if head is None:
            return run(["git", "rev-parse", "HEAD"]), "gh pr create (HEAD)"
        if repo or ":" in head:
            # 다른 저장소·포크의 브랜치는 로컬에서 같은 커밋인지 보장할 수 없다.
            return "", f"gh pr create --head {head}"
        return run(["git", "rev-parse", "--verify", "--quiet", f"{head}^{{commit}}"]), f"gh pr create --head {head}"
    target = merge_target(args)
    view = ["gh", "pr", "view"] + ([target] if target else []) + (["--repo", repo] if repo else [])
    view += ["--json", "headRefOid", "-q", ".headRefOid"]
    return run(view), f"gh pr merge {target or '(현재 브랜치)'}"


def main() -> int:
    data = json.load(sys.stdin)
    cmd = (data.get("tool_input") or {}).get("command") or ""
    if "gh" not in cmd:
        return 0
    ops = find_pr_ops(split_commands(cmd))
    if not ops:
        return 0

    project = os.environ.get("CLAUDE_PROJECT_DIR") or data.get("cwd") or "."
    try:
        os.chdir(project)
    except OSError:
        pass
    git_dir = run(["git", "rev-parse", "--git-common-dir"])
    passed: set[str] = set()
    if git_dir:
        try:
            with open(os.path.join(git_dir, "codex-review-passed")) as f:
                passed = {line.strip() for line in f if line.strip()}
        except OSError:
            pass

    for action, args in ops:
        sha, desc = target_sha(action, args)
        if not sha or sha not in passed:
            print(
                f"차단: {desc} 대상 커밋 {sha or '(확인 불가)'}에 대한 Codex 리뷰 통과 기록이 없습니다. "
                "codex-reviewer 에이전트로 리뷰를 받아 PASS한 뒤 다시 시도하세요. "
                "리뷰 후 커밋을 추가했다면 다시 리뷰해야 합니다.",
                file=sys.stderr,
            )
            return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
