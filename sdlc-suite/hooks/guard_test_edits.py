#!/usr/bin/env python3
"""PreToolUse hook: while a failing test is being fixed, the tests are the spec.

engineering-integrity section 2 says never weaken a check to make it pass. An agent
told "make this test pass" can satisfy the words by editing the test instead of
the code: a loosened assertion, a skip, a refreshed snapshot, a wider
tolerance in the runner config. A rule in a prompt is advice; this hook makes
it a boundary.

It does nothing until a fix task turns it on by creating `.sdlc/test-lock` in
the project (or running `guard_test_edits.py lock "<why>"`). While that file
exists, it denies:

- Edit, Write, MultiEdit and NotebookEdit on test files, snapshots, fixtures
  and test-runner configs;
- Bash commands that write to such a path (`sed -i`, `perl -i`, `rm`, `mv`,
  `cp` onto it, `tee`, `truncate`, `git checkout`/`git restore`, a `>`
  redirect into it);
- any tool call that would edit or remove the lock itself (reading it is fine).

The deny reason tells the agent to fix the code, or stop and report why it
believes the test is wrong, and let the user decide.

Overrides are the user's, not the agent's:
- an `allow: <glob>` line in the lock file permits matching paths (for a test
  the user agreed is wrong, or new tests the fix needs);
- `SDLC_ALLOW_TEST_EDITS=1` in the environment Claude Code was started with
  turns the guard off for that session. An agent cannot set it: a Bash
  `export` changes its shell, not the process that runs hooks.

`python guard_test_edits.py lock [reason...]` creates the lock, `unlock`
removes it, `status` prints it. Run `unlock` yourself; the hook denies an
agent running it.

Like transcript_detect.py it must never break a session by accident: bad or
unexpected input means no decision (exit 0, no output). Standard library only.
"""
from __future__ import annotations

import fnmatch
import glob
import json
import os
import re
import shlex
import sys
from pathlib import Path, PurePosixPath

LOCK = Path(".sdlc") / "test-lock"
OVERRIDE_ENV = "SDLC_ALLOW_TEST_EDITS"
FILE_TOOLS = {"Edit": "file_path", "Write": "file_path", "MultiEdit": "file_path",
              "NotebookEdit": "notebook_path"}

TEST_DIR = re.compile(
    r"(^|/)(tests?|__tests__|specs?|e2e|testdata|test[-_]data|fixtures|__fixtures__|"
    r"__snapshots__|[^/]+-snapshots|goldens?)/", re.IGNORECASE)
TEST_FILE = re.compile(
    r"(^|/)("
    r"test_[^/]+\.py|[^/]+_tests?\.py|conftest\.py"
    r"|[^/]+\.(test|spec)\.[cm]?[jt]sx?"
    r"|[^/]+_test\.(go|dart|rs|exs?)|[^/]+_spec\.rb"
    r"|(?-i:[^/]+Tests?\.(java|kt|cs|swift|scala))"
    r"|[^/]+\.snap"
    r"|(playwright|vitest|jest|karma|cypress|mocha)\.config\.[cm]?[jt]s"
    r"|\.mocharc\.[a-z]+|pytest\.ini|\.coveragerc"
    r")$", re.IGNORECASE)

# Bash: commands whose path arguments are written to.
WRITERS = {"rm", "mv", "tee", "truncate", "unlink", "shred", "touch"}
IN_PLACE_EDITORS = {"sed", "perl", "ruby"}
OPERATORS = {";", "&&", "||", "|", "&", "|&", "(", ")"}
REDIRECTS = {">", ">>", ">|", "&>", "&>>"}
GIT_PATH_COMMANDS = {"checkout", "restore", "rm", "mv", "clean"}
GIT_OPTS_WITH_VALUE = {"-C", "-c", "--git-dir", "--work-tree", "--namespace"}
HEREDOC = re.compile(r"<<-?\s*(['\"]?)(\w+)\1[^\n]*\n.*?\n\s*\2\s*(?=\n|$)", re.S)
GLOB_CHARS = re.compile(r"[*?\[]")


def is_test_path(path: str) -> bool:
    p = path.replace("\\", "/")
    return bool(TEST_DIR.search(p) or TEST_FILE.search(p))


def find_lock(cwd: str) -> Path | None:
    starts = [os.environ.get("CLAUDE_PROJECT_DIR"), cwd]
    for start in starts:
        if not start:
            continue
        d = Path(start).resolve()
        for cand in (d, *d.parents):
            if (cand / LOCK).is_file():
                return cand / LOCK
    return None


def read_lock(lock: Path) -> tuple[str, list[str]]:
    reason, allow = [], []
    for line in lock.read_text(encoding="utf-8", errors="replace").splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        if s.lower().startswith("allow:"):
            allow.append(s[6:].strip())
        else:
            reason.append(s)
    return " ".join(reason)[:300], [a for a in allow if a]


def absolute(path: str, cwd: str) -> str:
    p = os.path.expanduser(path)
    if not os.path.isabs(p):
        p = os.path.join(cwd, p)
    # realpath, as find_lock resolves the root: a project reached through a
    # symlink (macOS /var -> /private/var) must still compare inside the root.
    return os.path.realpath(p)


def relative(path: str, cwd: str, root: Path) -> str:
    p = Path(absolute(path, cwd))
    try:
        return PurePosixPath(p.relative_to(root)).as_posix()
    except ValueError:
        return p.as_posix()


def allowed(rel: str, allow: list[str]) -> bool:
    return any(fnmatch.fnmatchcase(rel, g) or fnmatch.fnmatchcase(rel, g.rstrip("/") + "/*")
               for g in allow)


def tokens(command: str) -> list[str]:
    """Shell words and operators, quotes honoured. Heredoc bodies are data, not commands."""
    command = HEREDOC.sub("", command)
    lex = shlex.shlex(command.replace("\n", " ; "), posix=True, punctuation_chars=True)
    lex.whitespace_split = True
    lex.commenters = "#"
    return list(lex)


def segments(toks: list[str]) -> list[tuple[list[str], list[str]]]:
    """Split into simple commands: (words, redirect targets)."""
    out, words, redirs, i = [], [], [], 0
    while i < len(toks):
        t = toks[i]
        if t in OPERATORS or t == ";;":
            out.append((words, redirs))
            words, redirs = [], []
        elif t in REDIRECTS:
            if i + 1 < len(toks):
                redirs.append(toks[i + 1])
            i += 1
        elif t in ("<", "<<", "<<<", ">&", "<&"):
            i += 1
        else:
            words.append(t)
        i += 1
    out.append((words, redirs))
    return out


def in_place_paths(cmd: str, args: list[str]) -> list[str] | None:
    """Files a sed/perl/ruby call edits in place, or None when it does not edit in place."""
    in_place = False
    paths, script_given, skip = [], False, False
    for a in args:
        if skip:
            skip = False
            continue
        if a == "--":
            continue
        if a == "--in-place" or a.startswith("--in-place="):
            in_place = True
        elif a in ("-e", "--expression", "-f", "--file") or (cmd == "perl" and a == "-E"):
            script_given = True
            skip = True
        elif a.startswith("--expression=") or a.startswith("--file="):
            script_given = True
        elif a.startswith("-") and len(a) > 1 and not a.startswith("--"):
            flags = a[1:]
            if "i" in flags:
                in_place = True
            if flags.endswith("e") or flags.endswith("f"):
                script_given = True
                skip = True
        elif not a.startswith("-"):
            paths.append(a)
    if not in_place:
        return None
    return paths if script_given else paths[1:]


def git_paths(args: list[str]) -> list[str]:
    i = 0
    while i < len(args) and args[i].startswith("-"):
        i += 2 if args[i] in GIT_OPTS_WITH_VALUE else 1
    if i >= len(args) or args[i] not in GIT_PATH_COMMANDS:
        return []
    return [a for a in args[i + 1:] if not a.startswith("-")]


def bash_targets(command: str, cwd: str) -> tuple[list[str], bool]:
    """Absolute paths a shell command writes to, and whether it runs `unlock`.

    Follows `cd` between commands and expands globs, so `cd .sdlc && rm test-lock`
    and `rm tests/*` name the files they hit. Best effort: a script that writes
    a file is not seen."""
    unlocks = "guard_test_edits" in command and re.search(r"\bunlock\b", command) is not None
    try:
        toks = tokens(command)
    except ValueError:
        toks = command.split()
    targets: list[str] = []
    here = cwd
    for words, redirs in segments(toks):
        found = list(redirs)
        while words and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", words[0]):
            words = words[1:]
        while words and words[0] in ("sudo", "env", "command", "xargs", "nohup", "time"):
            words = words[1:]
        if words:
            cmd, args = os.path.basename(words[0]), words[1:]
            paths = [a for a in args if not a.startswith("-")]
            if cmd == "cd":
                here = absolute(paths[0], here) if paths else os.path.expanduser("~")
                continue
            if cmd in ("cp", "install", "ln", "rsync"):
                found += paths[-1:]
            elif cmd in WRITERS:
                found += paths
            elif cmd in IN_PLACE_EDITORS:
                found += in_place_paths(cmd, args) or []
            elif cmd == "git":
                found += git_paths(args)
        for f in found:
            full = absolute(f, here)
            hits = glob.glob(full) if GLOB_CHARS.search(f) else []
            targets += hits or [full]
    return targets, unlocks


def deny(reason: str) -> None:
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": reason,
    }}))


def message(paths: list[str], lock: Path, why: str) -> str:
    named = ", ".join(paths[:5]) + (" ..." if len(paths) > 5 else "")
    return (f"Blocked by the sdlc-suite test lock ({lock}): {named} is a test file, snapshot, fixture or "
            f"test config, and a failing test is being fixed"
            + (f" ({why})" if why else "")
            + ". The test is the spec: fix the code under test, not the test (engineering-integrity "
              "section 2: never weaken a check to make it pass). If you believe the test itself is wrong, "
              "stop and report that with your evidence; only the user can permit the edit, by adding an "
              "'allow: <path or glob>' line to the lock file or removing it.")


def decide(payload: dict) -> str | None:
    if os.environ.get(OVERRIDE_ENV, "").strip().lower() in ("1", "true", "yes", "on"):
        return None
    cwd = payload.get("cwd") or os.getcwd()
    lock = find_lock(cwd)
    if lock is None:
        return None
    root = lock.parent.parent
    why, allow = read_lock(lock)
    tool = payload.get("tool_name")
    ti = payload.get("tool_input") or {}
    if tool in FILE_TOOLS:
        target = ti.get(FILE_TOOLS[tool])
        if not isinstance(target, str) or not target:
            return None
        rel = relative(target, cwd, root)
        if rel == LOCK.as_posix():
            return (f"Blocked: {lock} is the user's test lock; an agent fixing a failing test may not edit "
                    f"or remove it. Stop and report what you need instead.")
        if is_test_path(rel) and not allowed(rel, allow):
            return message([rel], lock, why)
        return None
    if tool == "Bash":
        command = ti.get("command")
        if not isinstance(command, str):
            return None
        targets, unlocks = bash_targets(command, cwd)
        rels = [relative(t, cwd, root) for t in targets]
        if unlocks or any(r == ".sdlc" or r.startswith(".sdlc/test-lock") for r in rels):
            return (f"Blocked: this command would change or remove the user's test lock ({lock}); an agent "
                    f"fixing a failing test may not. Stop and report what you need instead.")
        hits = [r for r in rels if is_test_path(r) and not allowed(r, allow)]
        if hits:
            return message(hits, lock, why)
    return None


def cli(argv: list[str]) -> int:
    # unlock/status act on the lock the hook would find (walking up from here);
    # lock creates one in the project dir when none is in force yet.
    lock = find_lock(os.getcwd()) or Path(os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()) / LOCK
    if argv[0] == "lock":
        lock.parent.mkdir(parents=True, exist_ok=True)
        if not lock.exists():
            lock.write_text((" ".join(argv[1:]) or "fixing a failing test") + "\n", encoding="utf-8")
        print(f"test lock on: {lock}")
    elif argv[0] == "unlock":
        lock.unlink(missing_ok=True)
        print(f"test lock off: {lock}")
    else:
        print(lock.read_text(encoding="utf-8") if lock.exists() else "test lock off", end="")
    return 0


def main() -> int:
    if len(sys.argv) > 1 and sys.argv[1] in ("lock", "unlock", "status"):
        return cli(sys.argv[1:])
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        if not isinstance(payload, dict):
            return 0
        reason = decide(payload)
    except Exception:
        return 0
    if reason:
        deny(reason)
    return 0


if __name__ == "__main__":
    sys.exit(main())
