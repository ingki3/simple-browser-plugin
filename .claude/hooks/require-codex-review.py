#!/usr/bin/env python3
"""PreToolUse(Bash) 훅: PR 생성·머지 전에 대상 커밋의 Codex 리뷰 통과 기록을 요구한다.

위협 모델: 이 훅은 Claude Code가 리뷰를 빠뜨리거나 리뷰 후 커밋을 추가한 채 PR을 올리는
실수를 막는 절차 가드다. 셸 접근 권한을 가진 사람의 의도적 우회는 막지 못하며(훅 파일
수정, 다른 터미널 사용 등), 그 경우의 강제는 GitHub 브랜치 보호의 몫이다.

셸 구문을 해석하는 대신 허용 목록으로 검사한다. 명령 어딘가에 gh와 pr이 보이면
다음 표준형만 허용하고 나머지는 모두 차단한다.

- gh pr merge <번호> [허용 옵션] --match-head-commit <PASS한 SHA>
  gh가 실행 시점에 head를 고정한다. --auto/--admin 불가, PR base는 main.
- gh pr create|new --base main [허용 옵션]
  원격 브랜치(--head 또는 현재 브랜치)의 SHA가 PASS 기록에 있어야 한다.

기록(.git/codex-review-passed)은 .claude/scripts/codex-review.sh가 main 대비 PASS일 때만 남긴다.
종료 코드 2면 명령이 차단된다.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys

SEPARATORS = set(";&|()`\n")
# 인용·이스케이프로 쪼갠 경우는 split_commands가 정규화한 단어로도 한 번 더 본다.
LOOSE = re.compile(r"\bgh\b.*\bpr\b", re.S)
BASE_BRANCH = "main"

# 옵션 허용 목록: 이름 -> 값을 받는지. 붙여 쓰기(-Hx, -fH)는 허용하지 않는다.
MERGE_FLAGS = {
    "--squash": False, "-s": False, "--merge": False, "-m": False,
    "--rebase": False, "-r": False, "--delete-branch": False, "-d": False,
    "--subject": True, "-t": True, "--body": True, "-b": True,
    "--body-file": True, "-F": True, "--match-head-commit": True,
}
CREATE_FLAGS = {
    "--fill": False, "-f": False, "--fill-first": False, "--fill-verbose": False,
    "--draft": False, "-d": False, "--no-maintainer-edit": False,
    "--title": True, "-t": True, "--body": True, "-b": True, "--body-file": True, "-F": True,
    "--base": True, "-B": True, "--head": True, "-H": True,
    "--label": True, "-l": True, "--assignee": True, "-a": True,
    "--reviewer": True, "-r": True, "--milestone": True, "-m": True,
}
# 같은 옵션의 짧은/긴 이름. 중복 지정 판정에 쓴다.
CANONICAL = {
    "-s": "--squash", "-m": "--merge", "-r": "--rebase", "-d": "--delete-branch",
    "-t": "--subject", "-b": "--body", "-F": "--body-file",
    "-B": "--base", "-H": "--head", "-f": "--fill", "-l": "--label", "-a": "--assignee",
}
# 머지·생성이 아닌 하위 명령. 단독 실행이면 검사 없이 허용한다.
OTHER_SUBCOMMANDS = {"view", "list", "status", "checks", "diff", "edit", "comment", "close", "reopen", "ready"}
ACTIONS = {"create":("create", CREATE_FLAGS), "new": ("create", CREATE_FLAGS), "merge": ("merge", MERGE_FLAGS)}

USAGE = (
    "PR 생성·머지 명령은 다음 형식으로 단독 실행하세요(다른 명령과 묶기, $(...), bash -c, eval,\n"
    "gh 전역 옵션, 붙여 쓴 짧은 옵션, 중복 옵션, 목록에 없는 옵션은 차단).\n"
    "  머지: gh pr merge <번호> --squash --match-head-commit <Codex PASS한 전체 SHA>\n"
    "  생성: 리뷰 통과 커밋을 push한 뒤 gh pr create --base main --title ... --body-file ...\n"
    "커밋 메시지 등에 gh와 pr이 함께 들어가면 git commit -F <파일>로 넘기세요."
)


def split_commands(cmd: str) -> list[list[str]]:
    """셸 명령 문자열을 명령 단위의 단어 목록으로 나눈다(인용·이스케이프 제거, 인용 안 구분자 무시)."""
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


def mentions_gh_pr(cmd: str, commands: list[list[str]]) -> bool:
    if LOOSE.search(cmd):
        return True
    words = [w for ws in commands for w in ws]
    return any(os.path.basename(w) == "gh" for w in words) and "pr" in words


def parse_args(args: list[str], allowed: dict[str, bool]) -> tuple[dict[str, str], list[str]] | str:
    """허용 목록대로 파싱한다. 성공하면 (옵션, 위치 인자), 실패하면 사유 문자열."""
    opts: dict[str, str] = {}
    positional: list[str] = []
    i = 0
    while i < len(args):
        a = args[i]
        if a.startswith("-") and a != "-":
            name, eq, value = a.partition("=")
            if name not in allowed or (eq and (not allowed[name] or not name.startswith("--"))):
                return f"허용 목록에 없는 옵션 형식: {a}"
            if allowed[name] and not eq:
                if i + 1 >= len(args):
                    return f"{name}에 값이 없습니다."
                i += 1
                value = args[i]
            key = CANONICAL.get(name, name)
            if key in opts:
                return f"{name} 옵션이 여러 번 지정되었습니다."
            opts[key] = value if allowed[name] else ""
        else:
            positional.append(a)
        i += 1
    return opts, positional


def run(cmd: list[str]) -> str:
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return r.stdout.strip() if r.returncode == 0 else ""


def remote_branch_sha(branch: str) -> str:
    out = run(["git", "ls-remote", "origin", f"refs/heads/{branch}"])
    return out.split()[0] if out else ""


def check(action: str, args: list[str], allowed: dict[str, bool], passed: set[str]) -> str | None:
    """통과면 None, 아니면 차단 사유."""
    parsed = parse_args(args, allowed)
    if isinstance(parsed, str):
        return parsed
    opts, positional = parsed

    if action == "merge":
        if len(positional) != 1 or not positional[0].isdigit():
            return "gh pr merge에는 PR 번호 하나를 지정해야 합니다."
        sha = opts.get("--match-head-commit")
        if not sha:
            return "gh pr merge에 --match-head-commit <리뷰 통과 SHA>가 없습니다."
        if sha not in passed:
            return f"--match-head-commit {sha}는 Codex 리뷰 통과 기록이 없는 커밋입니다."
        base = run(["gh", "pr", "view", positional[0], "--json", "baseRefName", "-q", ".baseRefName"])
        if base != BASE_BRANCH:
            return f"PR의 base({base or '확인 불가'})가 {BASE_BRANCH}가 아닙니다. 리뷰 기록은 {BASE_BRANCH} 대비로만 남습니다."
        return None

    if positional:
        return f"gh pr create에 알 수 없는 인자: {positional[0]}"
    if opts.get("--base") != BASE_BRANCH:
        return f"gh pr create에는 --base {BASE_BRANCH}를 명시해야 합니다."
    head = opts.get("--head")
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
    if not mentions_gh_pr(cmd, commands):
        return 0

    def block(reason: str) -> int:
        print(f"차단: {reason}\n{USAGE}\n리뷰는 codex-reviewer 에이전트로 받으세요.", file=sys.stderr)
        return 2

    words = commands[0] if len(commands) == 1 else []
    if len(words) < 3 or words[:2] != ["gh", "pr"] or "$" in cmd or "`" in cmd:
        return block("검사할 수 없는 형식의 명령입니다(gh pr 표준형 단독 실행만 허용).")
    if words[2] in OTHER_SUBCOMMANDS:
        return 0
    if words[2] not in ACTIONS:
        return block(f"gh pr {words[2]}: 허용 목록에 없는 하위 명령입니다.")
    action, allowed = ACTIONS[words[2]]

    # 명령이 실제로 실행될 디렉터리(worktree일 수 있음)를 기준으로 검사한다.
    workdir = data.get("cwd") or os.environ.get("CLAUDE_PROJECT_DIR") or "."
    try:
        os.chdir(workdir)
    except OSError:
        return block(f"작업 디렉터리 {workdir}에 들어갈 수 없습니다.")
    # gh의 기본 저장소가 origin이 아닐 수 있는 구성(fork + upstream 등)은 검사 대상을 확신할 수 없다.
    if run(["git", "remote"]).split() != ["origin"]:
        return block("원격이 origin 하나가 아닌 저장소에서는 PR 생성·머지를 검사할 수 없습니다.")
    passed: set[str] = set()
    git_dir = run(["git", "rev-parse", "--git-common-dir"])
    if git_dir:
        try:
            with open(os.path.join(git_dir, "codex-review-passed")) as f:
                passed = {line.strip() for line in f if line.strip()}
        except OSError:
            pass

    reason = check(action, words[3:], allowed, passed)
    return block(reason) if reason else 0


if __name__ == "__main__":
    sys.exit(main())
