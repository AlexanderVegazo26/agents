#!/usr/bin/env python3
"""Version gate for agents, skills and the plugin.

    python sdlc-suite/tools/bump.py                        # propose increments from the diff
    python sdlc-suite/tools/bump.py --base origin/main     # ...against a branch instead
    python sdlc-suite/tools/bump.py --check                # CI gate; exit 1 on a violation
    python sdlc-suite/tools/bump.py --apply                # write the proposed artifact versions
    python sdlc-suite/tools/bump.py --apply --plugin       # ...and the plugin version too
    python sdlc-suite/tools/bump.py --versions             # print the version table
    python sdlc-suite/tools/bump.py --versions --json      # the same table, machine-readable
    python sdlc-suite/tools/bump.py --marketplace          # regenerate marketplace.json
    python sdlc-suite/tools/bump.py --marketplace --check  # ...or fail if it is stale

Exit codes (the contract CI depends on -- do not change silently):
    0  clean, or a proposal was printed
    1  --check found a violation
    2  usage error, or the base ref could not be resolved

Why this exists
---------------
`sdlc-suite/USAGE.md` records the mechanism that makes a version load-bearing
here: installing copies the plugin into
`~/.claude/plugins/cache/<marketplace>/sdlc-suite/<version>/`, a snapshot rather
than a link. The version is therefore the *only* thing that moves a fix to a
consumer -- and until this tool existed it had to be edited by hand in two files,
with nothing at all recording which revision of a 463-line agent a consumer was
actually running.

Three separate failures follow from that, and each maps to a check below.

**A body that changes without its version.** The consumer's cache still says
1.0.0, the definition inside it is not the 1.0.0 anyone wrote, and there is no
way to establish which one they have. `--check` fails, naming the file.

**A tool grant that changes without a major.** "Major on an agent or skill: a
reporting contract or tool grant changed in a way a caller could depend on"
(`CONTRIBUTING.md`). A grant is the one half of that which is mechanically
checkable rather than a judgement, so it is enforced rather than suggested.

**A plugin bumped alone.** Bumping only the release train ships the cache
directory a new name and the same stale definitions. `--apply --plugin` refuses
while any changed artifact still carries its old version.

What is enforced and what is only proposed
------------------------------------------
Deliberately split, because a heuristic wired as a gate gets switched off.

*Enforced* (`--check`): every agent and skill carries a well-formed `version`;
the plugin's MAJOR is at least the highest artifact MAJOR; a changed body moved
its version forward; a changed `tools:` grant moved the MAJOR.

*Proposed only* (default mode): the major/minor/patch classification itself. It
reads the enclosing Markdown heading of every changed line and calls a change
under an output-contract heading major -- useful, and not something to fail a
pull request on. The author picks the level; `--check` only insists the version
moved, and that a grant change moved the major.

Not covered
-----------
Workflow minimum-agent-version enforcement (`Failure.ENV_DRIFT`) lives in
`sdlc-suite/workflows/` and is not wired here. `--versions --json` exists to
give that wiring its input, and its shape is part of the contract rather than
an implementation detail, so it is written down here:

    {"plugin": "1.0.3",
     "agents": {"<agent name>": "MAJOR.MINOR.PATCH", ...},   # 22 entries
     "skills": {"<skill name>": "MAJOR.MINOR.PATCH", ...}}   # 60 entries

A value is `null` only where the artifact carries no parseable version, which
`--check` treats as a violation — a consumer should read `null` as "unknown",
never as "old". Keys are the frontmatter `name`, which is also the filename
stem. New top-level keys may be added; existing ones will not change meaning.
"""

from __future__ import annotations

import argparse
import difflib
import json
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from generate_trees import parse_frontmatter  # noqa: E402  (same directory, one parser)

ROOT = Path(__file__).resolve().parents[2]
SRC_AGENTS = ROOT / "sdlc-suite" / "agents"
SRC_SKILLS = ROOT / "sdlc-suite" / "skills"
PLUGIN_JSON = ROOT / "sdlc-suite" / ".claude-plugin" / "plugin.json"
MARKETPLACE_JSON = ROOT / ".claude-plugin" / "marketplace.json"

INITIAL = "1.0.0"

SEMVER_RE = re.compile(r"^(\d+)\.(\d+)\.(\d+)$")
VERSION_LINE_RE = re.compile(r"^version:[ \t]*(.*)$", re.MULTILINE)
# Eats the newline too, unlike the editing regex above. Without that, removing
# the line leaves a blank one behind, so a file that only *gained* a version
# field compares as a content change and the tool tells you to bump 1.0.0 to
# 1.0.1 for the act of writing 1.0.0.
VERSION_LINE_STRIP_RE = re.compile(r"^version:[ \t]*.*\n", re.MULTILINE)
HEADING_RE = re.compile(r"^#{1,6} ")

# Headings whose content is a reporting contract a caller can depend on. Built
# from the headings actually present in sdlc-suite/agents/ on 2026-09-02 and
# checked against the near misses: it must NOT match "API Contract Verification",
# "API and Contract Design", "Artifact output" or "Memory & Output Location",
# which are procedures rather than contracts.
CONTRACT_HEADING_RE = re.compile(
    r"(?i)\b(output format|output contract|response format|report format"
    r"|reporting|skills loaded|definition of done)\b"
)

MAJOR, MINOR, PATCH = "major", "minor", "patch"
_RANK = {PATCH: 0, MINOR: 1, MAJOR: 2}


# --------------------------------------------------------------------------- #
# semver
# --------------------------------------------------------------------------- #

def parse_semver(value: str) -> tuple[int, int, int] | None:
    m = SEMVER_RE.match((value or "").strip())
    return (int(m.group(1)), int(m.group(2)), int(m.group(3))) if m else None


def increment(value: str, level: str) -> str:
    major, minor, patch = parse_semver(value) or (0, 0, 0)
    if level == MAJOR:
        return f"{major + 1}.0.0"
    if level == MINOR:
        return f"{major}.{minor + 1}.0"
    return f"{major}.{minor}.{patch + 1}"


def bump_level(old: str, new: str) -> str | None:
    """Which component moved, or None if the version did not move forward."""
    o, n = parse_semver(old), parse_semver(new)
    if o is None or n is None or n <= o:
        return None
    if n[0] > o[0]:
        return MAJOR
    if n[1] > o[1]:
        return MINOR
    return PATCH


def max_level(levels) -> str:
    return max(levels, key=lambda x: _RANK[x], default=PATCH)


# --------------------------------------------------------------------------- #
# git
# --------------------------------------------------------------------------- #

class GitError(RuntimeError):
    pass


def git(*args: str, allow_fail: bool = False) -> bytes:
    proc = subprocess.run(("git",) + args, cwd=str(ROOT), capture_output=True)
    if proc.returncode != 0:
        if allow_fail:
            raise GitError(proc.stderr.decode("utf-8", "replace").strip())
        raise GitError(
            f"git {' '.join(args)} failed ({proc.returncode}): "
            f"{proc.stderr.decode('utf-8', 'replace').strip()}"
        )
    return proc.stdout


def resolve_base(ref: str) -> str:
    """The commit to compare against: the merge base of `ref` and HEAD.

    A ref beginning with `-` is refused. Nothing here uses `shell=True`, so a
    hostile value cannot reach a shell — but git parses a leading dash as one of
    its own options, and this value arrives from CI as `github.base_ref`. It is
    cheaper to reject the shape than to reason about every git subcommand it
    could later be threaded through.

    Three-dot semantics, so a pull request is judged on what it changed and not
    on what main moved on to underneath it. `--base HEAD` collapses to HEAD,
    which is what makes a push to main with a clean tree an empty diff and
    therefore a pass rather than a failure.
    """
    if ref.startswith("-"):
        raise GitError(f"base ref {ref!r} starts with '-'; git would read it as an option")
    try:
        rev = git("rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}").decode().strip()
    except GitError:
        rev = ""
    if not rev:
        raise GitError(
            f"base ref {ref!r} does not resolve to a commit. In CI this usually "
            f"means the checkout has no history for it: fetch the base branch, or "
            f"pass a ref that exists."
        )
    try:
        return git("merge-base", rev, "HEAD").decode().strip() or rev
    except GitError:
        return rev


def changed_paths(base: str) -> dict[str, str]:
    """{posix path: status letter} for the diff base..worktree, plus untracked.

    `git diff <base>` compares against the working tree, not against HEAD, so a
    contributor running this before committing is judged on what they actually
    have. In CI the working tree *is* the checked-out commit, so the two
    coincide. Untracked files are added explicitly because `git diff` cannot see
    them, and a brand-new agent that is missing its version field is exactly the
    case worth catching on the pull request that introduces it.
    """
    out: dict[str, str] = {}
    raw = git("diff", "--name-status", "--no-renames", base).decode("utf-8", "replace")
    for line in raw.splitlines():
        if not line.strip():
            continue
        parts = line.split("\t")
        if len(parts) >= 2:
            out[parts[-1].replace("\\", "/")] = parts[0][:1]
    untracked = git("ls-files", "--others", "--exclude-standard").decode("utf-8", "replace")
    for line in untracked.splitlines():
        if line.strip():
            out.setdefault(line.strip().replace("\\", "/"), "A")
    return out


def blob_at(base: str, rel_posix: str) -> str | None:
    """File content at `base`, or None if it did not exist there.

    `rel_posix`, never a `Path`: on Windows a Path renders with backslashes and
    git rejects the pathspec outright.
    """
    try:
        return git("show", f"{base}:{rel_posix}", allow_fail=True).decode("utf-8", "replace")
    except GitError:
        return None


# --------------------------------------------------------------------------- #
# Artifacts
# --------------------------------------------------------------------------- #

def read_lf(p: Path) -> str:
    """read_bytes, never read_text -- text mode hides a CRLF file behind its LF twin."""
    return p.read_bytes().decode("utf-8").replace("\r\n", "\n").replace("\r", "\n")


def version_of(text: str | None) -> str | None:
    if text is None:
        return None
    try:
        front, _ = parse_frontmatter(text.replace("\r\n", "\n"))
    except ValueError:
        return None
    return front.get("version")


def strip_version_line(text: str | None) -> str | None:
    if text is None:
        return None
    return VERSION_LINE_STRIP_RE.sub("", text.replace("\r\n", "\n"))


class Artifact:
    """One versioned unit: an agent file, or a skill *directory*.

    A skill is its directory, not its `SKILL.md`. `generate_trees.py` copies
    `skills/<name>/**` recursively, and `commandcode-suite` has already lost
    `exploration-charter/personas-schema-template.yaml` without any name-level
    check noticing. So a change to any file under the directory is a change to
    the skill, and must move the version in its `SKILL.md`.
    """

    def __init__(self, kind: str, name: str, version_file: Path, root: Path):
        self.kind = kind
        self.name = name
        self.version_file = version_file
        self.root = root

    @property
    def rel(self) -> str:
        return self.version_file.relative_to(ROOT).as_posix()

    @property
    def root_rel(self) -> str:
        return self.root.relative_to(ROOT).as_posix()

    @property
    def label(self) -> str:
        return f"{self.kind} {self.name}"

    def current_text(self) -> str | None:
        return read_lf(self.version_file) if self.version_file.is_file() else None

    def current_version(self) -> str | None:
        return version_of(self.current_text())


def discover() -> list[Artifact]:
    out = [
        Artifact("agent", p.stem, p, p)
        for p in sorted(SRC_AGENTS.glob("*.md"))
    ]
    out += [
        Artifact("skill", d.name, d / "SKILL.md", d)
        for d in sorted(p for p in SRC_SKILLS.iterdir() if p.is_dir())
    ]
    return out


def plugin_version(text: str | None = None) -> str | None:
    raw = text if text is not None else PLUGIN_JSON.read_bytes().decode("utf-8")
    try:
        return json.loads(raw).get("version")
    except json.JSONDecodeError:
        return None


# --------------------------------------------------------------------------- #
# Classification -- proposal only, never a gate
# --------------------------------------------------------------------------- #

def enclosing_heading(lines: list[str], index: int) -> str:
    for k in range(min(index, len(lines) - 1), -1, -1):
        if HEADING_RE.match(lines[k]):
            return lines[k]
    return ""


def classify(old_text: str | None, new_text: str | None,
             extra_files_changed: list[str]) -> tuple[str, list[str], bool]:
    """Propose a level. Returns (level, reasons, grant_changed).

    `grant_changed` is the one signal `--check` enforces, because "a tool grant
    changed" is a fact about two strings rather than a reading of intent.
    """
    reasons: list[str] = []
    levels: list[str] = []
    grant_changed = False

    if old_text is None:
        return MINOR, ["new artifact"], False
    if new_text is None:
        return MAJOR, ["artifact removed"], False

    try:
        old_front, old_body = parse_frontmatter(old_text)
    except ValueError:
        old_front, old_body = {}, old_text
    try:
        new_front, new_body = parse_frontmatter(new_text)
    except ValueError:
        new_front, new_body = {}, new_text

    if old_front.get("tools", "") != new_front.get("tools", ""):
        grant_changed = True
        levels.append(MAJOR)
        reasons.append("tools: grant changed")
    if old_front.get("name", "") != new_front.get("name", ""):
        levels.append(MAJOR)
        reasons.append("name: changed")
    if old_front.get("description", "") != new_front.get("description", ""):
        levels.append(MINOR)
        reasons.append("description: changed")
    if old_front.get("skills", "") != new_front.get("skills", ""):
        levels.append(MINOR)
        reasons.append("skills: wiring changed")
    for key in set(old_front) | set(new_front):
        if key in ("tools", "name", "description", "skills", "version"):
            continue
        if old_front.get(key) != new_front.get(key):
            levels.append(PATCH)
            reasons.append(f"{key}: changed")

    old_lines = old_body.splitlines()
    new_lines = new_body.splitlines()
    matcher = difflib.SequenceMatcher(None, old_lines, new_lines, autojunk=False)
    touched_contract = False
    touched_heading = False
    body_changed = False
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            continue
        body_changed = True
        for lines, lo, hi in ((old_lines, i1, i2), (new_lines, j1, j2)):
            for idx in range(lo, hi):
                if HEADING_RE.match(lines[idx]):
                    touched_heading = True
                    if CONTRACT_HEADING_RE.search(lines[idx]):
                        touched_contract = True
                if CONTRACT_HEADING_RE.search(enclosing_heading(lines, idx)):
                    touched_contract = True

    if touched_contract:
        levels.append(MAJOR)
        reasons.append("a reporting-contract section changed")
    elif touched_heading:
        levels.append(MINOR)
        reasons.append("a section was added or removed")
    elif body_changed:
        levels.append(PATCH)
        reasons.append("body wording changed")

    if extra_files_changed:
        levels.append(MINOR)
        reasons.append(
            "supporting file(s) changed: " + ", ".join(sorted(extra_files_changed))
        )

    if not reasons:
        return PATCH, [], False
    return max_level(levels), reasons, grant_changed


# --------------------------------------------------------------------------- #
# The gate
# --------------------------------------------------------------------------- #

class Finding:
    def __init__(self, rule: str, path: str, message: str):
        self.rule, self.path, self.message = rule, path, message

    def __str__(self) -> str:
        return f"{self.rule}: {self.path}: {self.message}"


def tree_state_findings(artifacts: list[Artifact]) -> list[Finding]:
    """Checks that need no diff at all, so a push with a clean tree still gates.

    The MAJOR-only comparison is deliberate. `CONTRIBUTING.md` propagates *major*
    to the plugin and nothing else -- "a major bump on any agent is a major bump
    on the plugin" -- so comparing full semver would turn the first minor bump on
    any one of 82 artifacts into a red build for a rule nobody wrote.
    """
    out: list[Finding] = []
    highest_major = 0
    for a in artifacts:
        raw = a.current_version()
        if raw is None:
            out.append(Finding(
                "missing-version", a.rel,
                f"{a.label} carries no `version:` field. Every agent and skill "
                f"needs one; see CONTRIBUTING.md 'Versioning and compatibility'."))
            continue
        parsed = parse_semver(raw)
        if parsed is None:
            out.append(Finding("bad-version", a.rel,
                               f"{a.label} version {raw!r} is not MAJOR.MINOR.PATCH"))
            continue
        highest_major = max(highest_major, parsed[0])

    pv = plugin_version()
    parsed_pv = parse_semver(pv or "")
    if parsed_pv is None:
        out.append(Finding("bad-version", PLUGIN_JSON.relative_to(ROOT).as_posix(),
                           f"plugin version {pv!r} is not MAJOR.MINOR.PATCH"))
    elif parsed_pv[0] < highest_major:
        out.append(Finding(
            "plugin-behind", PLUGIN_JSON.relative_to(ROOT).as_posix(),
            f"plugin is {pv} but an artifact has reached major {highest_major}. "
            f"A major bump on any agent or skill is a major bump on the plugin."))
    return out


class Proposal:
    def __init__(self, artifact: Artifact, status: str, old_version: str | None,
                 new_version: str | None, level: str, reasons: list[str],
                 grant_changed: bool, body_changed: bool):
        self.artifact = artifact
        self.status = status
        self.old_version = old_version
        self.new_version = new_version
        self.level = level
        self.reasons = reasons
        self.grant_changed = grant_changed
        self.body_changed = body_changed

    @property
    def moved(self) -> str | None:
        if self.old_version is None or self.new_version is None:
            return None
        return bump_level(self.old_version, self.new_version)

    @property
    def suggested(self) -> str:
        base = self.new_version or self.old_version or INITIAL
        return increment(base, self.level)


def analyse(base: str, artifacts: list[Artifact]) -> list[Proposal]:
    diff = changed_paths(base)
    proposals: list[Proposal] = []
    for a in artifacts:
        prefix = a.root_rel + ("/" if a.root.is_dir() else "")
        touched = {
            p: s for p, s in diff.items()
            if p == a.rel or (a.root.is_dir() and p.startswith(prefix))
        }
        if not touched:
            continue

        old_text = blob_at(base, a.rel)
        new_text = a.current_text()
        if old_text is None and new_text is None:
            continue

        status = "M"
        if old_text is None:
            status = "A"
        elif new_text is None:
            status = "D"

        extra = [p for p in touched if p != a.rel]
        # A change confined to the `version:` line is the bump itself, not
        # content. Without this, applying a bump would demand another bump.
        content_changed = bool(extra) or (
            strip_version_line(old_text) != strip_version_line(new_text)
        )

        level, reasons, grant_changed = classify(old_text, new_text, extra)
        proposals.append(Proposal(
            artifact=a, status=status,
            old_version=version_of(old_text), new_version=version_of(new_text),
            level=level, reasons=reasons, grant_changed=grant_changed,
            body_changed=content_changed,
        ))

    # `discover()` reads the disk, so an artifact that was deleted is not in it
    # and the removal rule could never fire on a real diff -- it would have been
    # exercised only by its own self-test, which is the definition of a
    # decorative gate. Deletions therefore come from the diff, not the disk.
    known = {a.rel for a in artifacts}
    for path, status in sorted(diff.items()):
        if status != "D" or path in known:
            continue
        agent = re.fullmatch(r"sdlc-suite/agents/([^/]+)\.md", path)
        skill = re.fullmatch(r"sdlc-suite/skills/([^/]+)/SKILL\.md", path)
        if not (agent or skill):
            continue
        kind, name = ("agent", agent.group(1)) if agent else ("skill", skill.group(1))
        gone = Artifact(kind, name, ROOT / path, ROOT / path)
        old_text = blob_at(base, path)
        level, reasons, grant_changed = classify(old_text, None, [])
        proposals.append(Proposal(
            artifact=gone, status="D",
            old_version=version_of(old_text), new_version=None,
            level=level, reasons=reasons, grant_changed=grant_changed,
            body_changed=True,
        ))
    return proposals


def findings_for(p: Proposal, plugin_major_moved: bool = False) -> list[Finding]:
    """Judge one changed artifact. Pure -- no git, no filesystem.

    Kept separate from `diff_findings` so `--selftest` can drive it with a
    synthetic before/after pair. A gate whose only evidence is that it was green
    on the day it was written is not a gate.
    """
    a = p.artifact
    if p.status == "D":
        # Satisfiable on purpose. "Removing an agent is a major plugin bump and
        # requires one release of deprecation notice" has two halves, and only
        # the first is checkable from a diff -- whether some earlier release
        # carried the notice is not. An unconditional failure here could not be
        # cleared by any action the author can take in the pull request, and a
        # gate nobody can go green against is a gate that gets deleted.
        if plugin_major_moved:
            return []
        return [Finding(
            "removed-artifact", a.rel,
            f"{a.label} was removed, but the plugin MAJOR did not move in the "
            f"same change. Removal is a major plugin bump. The other half of the "
            f"policy is not checkable from a diff: the description must have "
            f"carried a deprecation notice for one release first "
            f"(CONTRIBUTING.md).")]
    if p.status == "A":
        return []                          # tree-state check owns the new file
    if not p.body_changed:
        return []                          # version-only edit: the bump itself
    if p.new_version is None:
        return [Finding("missing-version", a.rel,
                        f"{a.label} changed but carries no `version:` field")]
    if p.old_version is None:
        # The field is being introduced by this diff, so there is no earlier
        # version for a consumer to be confused by: whatever number lands here
        # *defines* this content. Requiring a bump would mean shipping the field
        # at 1.0.1 with no 1.0.0 having ever existed.
        return []

    moved = p.moved
    if moved is None:
        return [Finding(
            "version-not-moved", a.rel,
            f"{a.label} body changed but version did not move forward "
            f"({p.old_version} -> {p.new_version}). Suggested: "
            f"{increment(p.old_version, p.level)} ({p.level}"
            + (f"; {', '.join(p.reasons)}" if p.reasons else "") + ")")]
    if p.grant_changed and moved != MAJOR:
        return [Finding(
            "grant-change-needs-major", a.rel,
            f"{a.label} changed its `tools:` grant but moved only the {moved} "
            f"({p.old_version} -> {p.new_version}). A tool grant is part of "
            f"the contract a caller depends on: "
            f"{increment(p.old_version, MAJOR)} is the smallest valid move.")]
    return []


def diff_findings(base: str, proposals: list[Proposal]) -> list[Finding]:
    out: list[Finding] = []
    unbumped: list[str] = []

    old_plugin = plugin_version(blob_at(base, PLUGIN_JSON.relative_to(ROOT).as_posix()))
    new_plugin = plugin_version()
    op, np_ = parse_semver(old_plugin or ""), parse_semver(new_plugin or "")
    plugin_major_moved = bool(op and np_ and np_[0] > op[0])

    for p in proposals:
        found = findings_for(p, plugin_major_moved=plugin_major_moved)
        out += found
        if any(f.rule in ("version-not-moved", "missing-version") for f in found):
            unbumped.append(p.artifact.rel)

    if old_plugin and new_plugin and old_plugin != new_plugin and unbumped:
        out.append(Finding(
            "plugin-bumped-alone", PLUGIN_JSON.relative_to(ROOT).as_posix(),
            f"plugin moved {old_plugin} -> {new_plugin} while "
            f"{len(unbumped)} changed artifact(s) kept their old version: "
            f"{', '.join(unbumped[:5])}"
            + (" ..." if len(unbumped) > 5 else "")
            + ". Bumping the release train alone ships a new cache directory "
              "holding the same stale definitions."))
    return out


# --------------------------------------------------------------------------- #
# marketplace.json
# --------------------------------------------------------------------------- #

def render_marketplace() -> bytes:
    """marketplace.json with every plugin version taken from its own plugin.json.

    Only the version is derived. `name`, `description`, `keywords` and `owner`
    legitimately differ from `plugin.json` -- the marketplace card is written for
    a browsing reader, the manifest for an installed one -- so the whole file is
    not generated, just the one field that was being maintained in two places and
    silently allowed to disagree.
    """
    data = json.loads(MARKETPLACE_JSON.read_bytes().decode("utf-8"))
    entries = data.get("plugins", [])
    if not entries:
        # Zero entries renders byte-identical output and reports "in sync".
        # Scanning nothing is not the same as finding nothing wrong.
        raise ValueError(
            f"{MARKETPLACE_JSON.relative_to(ROOT).as_posix()} lists no plugins — "
            f"the check has stopped checking anything")
    for entry in entries:
        name = entry.get("name", "<unnamed>")
        source = entry.get("source")
        if not isinstance(source, str):
            raise ValueError(f"plugin entry {name!r} has no string `source`")
        # `source` is relative to the marketplace ROOT, not to the directory
        # holding marketplace.json. Getting that wrong resolved "./sdlc-suite"
        # to `.claude-plugin/sdlc-suite`, which does not exist — and the first
        # draft of this function skipped what it could not resolve, so it
        # printed "in sync" over a genuine 1.0.3-vs-1.0.4 disagreement. Every
        # unresolvable entry is therefore an error, never a skip.
        manifest = (ROOT / source / ".claude-plugin" / "plugin.json").resolve()
        # `source` is data from a file a pull request can edit. Nothing here
        # executes it, but a `../..` would make this tool read a JSON file
        # outside the repository and copy a value out of it, so the resolved
        # path is required to stay inside the tree.
        if not manifest.is_relative_to(ROOT):
            raise ValueError(
                f"plugin entry {name!r} has source {source!r}, which resolves "
                f"outside the repository ({manifest})")
        if not manifest.is_file():
            raise ValueError(
                f"plugin entry {name!r} has source {source!r}, but no manifest at "
                f"{manifest} — cannot determine its version")
        version = json.loads(manifest.read_bytes().decode("utf-8")).get("version")
        if not version:
            raise ValueError(f"{manifest} carries no `version`")
        entry["version"] = version
    return (json.dumps(data, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def marketplace_command(check: bool) -> int:
    rel = MARKETPLACE_JSON.relative_to(ROOT).as_posix()
    try:
        want = render_marketplace()
    except (ValueError, json.JSONDecodeError, OSError) as exc:
        print(f"FAIL: cannot render {rel}: {exc}", file=sys.stderr)
        return 2
    have = MARKETPLACE_JSON.read_bytes()
    if want == have:
        print(f"OK: {rel} version matches every plugin's own plugin.json "
              f"({plugin_version()})")
        return 0
    if check:
        stale = json.loads(have.decode("utf-8"))["plugins"][0].get("version")
        print(f"FAIL: {rel} is out of date with plugin.json", file=sys.stderr)
        print(f"  marketplace.json: {stale!r}", file=sys.stderr)
        print(f"  plugin.json:      {plugin_version()!r}", file=sys.stderr)
        print("plugin.json is the single source. "
              "Run: python sdlc-suite/tools/bump.py --marketplace", file=sys.stderr)
        return 1
    MARKETPLACE_JSON.write_bytes(want)
    print(f"Regenerated {rel} from plugin.json ({plugin_version()})")
    return 0


# --------------------------------------------------------------------------- #
# Writing versions
# --------------------------------------------------------------------------- #

def set_version(path: Path, version: str) -> bool:
    """Set or insert `version:` in a Markdown frontmatter block. LF on write."""
    text = read_lf(path)
    if not text.startswith("---\n"):
        raise ValueError(f"{path} has no frontmatter")
    end = text.index("\n---\n", 3)
    front, rest = text[4:end + 1], text[end + 1:]
    if VERSION_LINE_RE.search(front):
        new_front = VERSION_LINE_RE.sub(f"version: {version}", front, count=1)
    else:
        lines = front.splitlines(keepends=True)
        at = 1 if lines and lines[0].startswith("name:") else 0
        lines.insert(at, f"version: {version}\n")
        new_front = "".join(lines)
    updated = "---\n" + new_front + rest
    if updated == text:
        return False
    path.write_text(updated, encoding="utf-8", newline="\n")
    return True


def set_plugin_version(version: str) -> bool:
    data = json.loads(PLUGIN_JSON.read_bytes().decode("utf-8"))
    if data.get("version") == version:
        return False
    data["version"] = version
    PLUGIN_JSON.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n",
                           encoding="utf-8", newline="\n")
    return True


# --------------------------------------------------------------------------- #
# Reporting
# --------------------------------------------------------------------------- #

def print_versions(artifacts: list[Artifact], as_json: bool) -> int:
    agents = {a.name: a.current_version() for a in artifacts if a.kind == "agent"}
    skills = {a.name: a.current_version() for a in artifacts if a.kind == "skill"}
    if as_json:
        print(json.dumps({"plugin": plugin_version(), "agents": agents,
                          "skills": skills}, indent=2, ensure_ascii=False))
        return 0
    print(f"plugin  {plugin_version()}")
    for label, table in (("agents", agents), ("skills", skills)):
        print(f"\n{label} ({len(table)})")
        for name, version in sorted(table.items()):
            print(f"  {version or '(none)':<10} {name}")
    return 0


def print_proposals(base: str, proposals: list[Proposal]) -> None:
    if not proposals:
        print(f"No agent or skill changed against {base[:12]}; nothing to bump.")
        return
    print(f"{len(proposals)} artifact(s) changed against {base[:12]}\n")
    for p in sorted(proposals, key=lambda x: (x.artifact.kind, x.artifact.name)):
        old = p.old_version or "(none)"
        if p.status == "D":
            print(f"  REMOVED  {p.artifact.label} ({old}) "
                  f"-> major plugin bump + deprecation notice")
            continue
        if p.status == "A":
            print(f"  NEW      {p.artifact.label} at {p.new_version or '(no version!)'}")
            continue
        if not p.body_changed:
            print(f"  bumped   {p.artifact.label} {old} -> {p.new_version}")
            continue
        if p.old_version is None:
            # The field is being introduced by this very diff. Reporting that as
            # "NEEDS BUMP" would tell the author to bump 1.0.0 to 1.0.1 for the
            # act of writing 1.0.0, which is how a gate earns a reputation for
            # crying wolf and gets switched off.
            print(f"  new      {p.artifact.label} first versioned at "
                  f"{p.new_version or '(no version!)'}")
            continue
        moved = p.moved
        marker = "ok" if moved else "NEEDS BUMP"
        print(f"  {marker:<8} {p.artifact.label} {old} -> "
              f"{p.new_version if moved else p.suggested}  [{p.level}]")
        for reason in p.reasons:
            print(f"               - {reason}")

    content = [p for p in proposals if p.body_changed and p.status == "M"]
    if content:
        level = max_level([p.level for p in content])
        print(f"\nplugin: {plugin_version()} -> "
              f"{increment(plugin_version() or INITIAL, level)} ({level})")
        print("The plugin bump is a release act, not an edit -- move it when the "
              "release is cut, and regenerate marketplace.json with --marketplace.")


# --------------------------------------------------------------------------- #
# Self-test
# --------------------------------------------------------------------------- #

def _pair(old: str, new: str, extra: list[str] | None = None) -> Proposal:
    extra = extra or []
    level, reasons, grant = classify(old, new, extra)
    return Proposal(
        artifact=Artifact("agent", "demo", ROOT / "sdlc-suite" / "agents" / "demo.md",
                          ROOT / "sdlc-suite" / "agents" / "demo.md"),
        status="M" if old and new else ("A" if not old else "D"),
        old_version=version_of(old), new_version=version_of(new),
        level=level, reasons=reasons, grant_changed=grant,
        body_changed=bool(extra) or strip_version_line(old) != strip_version_line(new),
    )


def _doc(version: str | None, tools: str, body: str) -> str:
    front = "name: demo\n"
    if version:
        front += f"version: {version}\n"
    front += f"description: A demo agent. Do NOT use.\ntools: {tools}\n"
    return f"---\n{front}---\n\n{body}\n"


BASE_BODY = "# Demo\n\n## 1. Method\n\nDo the thing.\n\n## 6. Output Format\n\nOne line.\n"


def selftest() -> int:
    """Drive every rule to red, then to green. No git, no filesystem.

    The rules this file adds are the only thing standing between a changed
    definition and a consumer's stale cache. Each case below was watched failing
    against the opposite input before it was written down; running it here means
    a future edit that quietly defeats one of them shows up as a red step rather
    than as nothing at all.
    """
    cases: list[tuple[str, list[Finding], str | None]] = []

    def case(label: str, findings: list[Finding], expect_rule: str | None):
        cases.append((label, findings, expect_rule))

    # 1. The headline rule: body changed, version stood still.
    case("body changed, version unmoved",
         findings_for(_pair(_doc("1.0.0", "Read", BASE_BODY),
                            _doc("1.0.0", "Read", BASE_BODY + "\nAnother rule.\n"))),
         "version-not-moved")

    # 2. Same change, version moved -> silent. The control for case 1: without
    #    it, a rule that fired unconditionally would look identical.
    case("body changed, version moved",
         findings_for(_pair(_doc("1.0.0", "Read", BASE_BODY),
                            _doc("1.0.1", "Read", BASE_BODY + "\nAnother rule.\n"))),
         None)

    # 3. A tool grant is contract. A patch does not cover it.
    case("tools grant changed, patch bump",
         findings_for(_pair(_doc("1.0.0", "Read", BASE_BODY),
                            _doc("1.0.1", "Read, Bash", BASE_BODY))),
         "grant-change-needs-major")

    # 4. ...and a major does.
    case("tools grant changed, major bump",
         findings_for(_pair(_doc("1.0.0", "Read", BASE_BODY),
                            _doc("2.0.0", "Read, Bash", BASE_BODY))),
         None)

    # 5. Version moved and nothing else: the bump itself, not an unrecorded edit.
    case("version-only edit",
         findings_for(_pair(_doc("1.0.0", "Read", BASE_BODY),
                            _doc("1.0.1", "Read", BASE_BODY))),
         None)

    # 6. Introducing the field on unchanged content is not a violation.
    case("version field introduced",
         findings_for(_pair(_doc(None, "Read", BASE_BODY),
                            _doc("1.0.0", "Read", BASE_BODY))),
         None)

    # 7. A skill's supporting file changed; SKILL.md itself did not. A skill is
    #    its directory -- this is the shape that lost
    #    exploration-charter/personas-schema-template.yaml unnoticed.
    case("supporting file changed, version unmoved",
         findings_for(_pair(_doc("1.0.0", "Read", BASE_BODY),
                            _doc("1.0.0", "Read", BASE_BODY),
                            extra=["sdlc-suite/skills/demo/template.yaml"])),
         "version-not-moved")

    # 8. Removal without a major plugin bump.
    case("artifact removed, plugin major unmoved",
         findings_for(_pair(_doc("1.0.0", "Read", BASE_BODY), "")),
         "removed-artifact")

    # 9. ...and with one, which is the half of the policy a diff can show.
    case("artifact removed, plugin major moved",
         findings_for(_pair(_doc("1.0.0", "Read", BASE_BODY), ""),
                      plugin_major_moved=True),
         None)

    failures = 0
    for label, findings, expect in cases:
        rules = sorted({f.rule for f in findings})
        ok = (rules == [expect]) if expect else (rules == [])
        print(f"  {'ok  ' if ok else 'FAIL'} {label:<44} -> {rules or ['(clean)']}")
        if not ok:
            failures += 1
            print(f"       expected {[expect] if expect else '(clean)'}")

    # The classifier's own proposals. Advisory in the tool, asserted here so a
    # regression in the heading scan is visible rather than silently degrading
    # every proposal to `patch`.
    proposals = [
        ("contract section edited -> major",
         classify(_doc("1.0.0", "Read", BASE_BODY),
                  _doc("1.0.0", "Read", BASE_BODY.replace("One line.", "Two lines.")),
                  [])[0], MAJOR),
        ("new section -> minor",
         classify(_doc("1.0.0", "Read", BASE_BODY),
                  _doc("1.0.0", "Read", BASE_BODY + "\n## 7. Extra\n\nMore.\n"),
                  [])[0], MINOR),
        ("wording -> patch",
         classify(_doc("1.0.0", "Read", BASE_BODY),
                  _doc("1.0.0", "Read", BASE_BODY.replace("Do the thing.", "Do that thing.")),
                  [])[0], PATCH),
    ]
    for label, got, want in proposals:
        ok = got == want
        print(f"  {'ok  ' if ok else 'FAIL'} {label:<44} -> {got}")
        if not ok:
            failures += 1
            print(f"       expected {want}")

    if failures:
        print(f"\nFAIL: {failures} self-test case(s) did not behave as specified",
              file=sys.stderr)
        return 1
    print(f"\nOK: {len(cases) + len(proposals)} self-test cases; every rule "
          f"observed both firing and staying silent")
    return 0


# --------------------------------------------------------------------------- #

def main(argv=None) -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")

    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", default="HEAD",
                    help="ref to compare against (default: HEAD, i.e. the working "
                         "tree. Use --base origin/main on a branch.)")
    ap.add_argument("--check", action="store_true",
                    help="exit 1 on a violation; write nothing")
    ap.add_argument("--apply", action="store_true",
                    help="write the proposed artifact versions")
    ap.add_argument("--plugin", action="store_true",
                    help="with --apply, also move the plugin version")
    ap.add_argument("--versions", action="store_true",
                    help="print the current version table and exit")
    ap.add_argument("--json", action="store_true",
                    help="with --versions, emit JSON")
    ap.add_argument("--marketplace", action="store_true",
                    help="regenerate .claude-plugin/marketplace.json from plugin.json")
    ap.add_argument("--selftest", action="store_true",
                    help="drive every rule to red and to green; needs no git history")
    args = ap.parse_args(argv)

    if args.selftest:
        return selftest()

    artifacts = discover()
    if not artifacts:
        print(f"FAIL: no agents or skills found under {SRC_AGENTS} / {SRC_SKILLS} "
              f"-- the check has stopped checking anything", file=sys.stderr)
        return 2

    if args.marketplace:
        return marketplace_command(args.check)

    if args.versions:
        return print_versions(artifacts, args.json)

    if args.apply and args.check:
        ap.error("--apply and --check are mutually exclusive")

    try:
        base = resolve_base(args.base)
    except GitError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    findings = tree_state_findings(artifacts)
    proposals = analyse(base, artifacts)
    findings += diff_findings(base, proposals)

    if args.check:
        for f in sorted(findings, key=lambda x: (x.rule, x.path)):
            print(str(f), file=sys.stderr)
        if findings:
            print(f"\nFAIL: {len(findings)} versioning violation(s) over "
                  f"{len(artifacts)} artifacts (base {base[:12]})", file=sys.stderr)
            print("See CONTRIBUTING.md 'Versioning and compatibility'. "
                  "Propose increments with: python sdlc-suite/tools/bump.py",
                  file=sys.stderr)
            return 1
        print(f"OK: {len(artifacts)} artifacts versioned, "
              f"{len(proposals)} changed against {base[:12]}, "
              f"plugin {plugin_version()}")
        return 0

    for f in sorted(findings, key=lambda x: (x.rule, x.path)):
        print(str(f))
    if findings:
        print("")

    if not args.apply:
        print_proposals(base, proposals)
        return 0

    # --apply. Refuse to move the release train past definitions that did not move.
    stale = [p for p in proposals
             if p.status == "M" and p.body_changed and p.moved is None
             and p.old_version is not None]
    if args.plugin and not stale and not proposals:
        print("Nothing changed; refusing to bump the plugin alone. "
              "A new cache directory holding identical definitions helps nobody.",
              file=sys.stderr)
        return 2

    written = 0
    for p in stale:
        target = increment(p.old_version, p.level)
        if set_version(p.artifact.version_file, target):
            written += 1
            print(f"  {p.artifact.label}: {p.old_version} -> {target} [{p.level}]")
    missing = [a for a in artifacts if a.current_version() is None]
    for a in missing:
        if set_version(a.version_file, INITIAL):
            written += 1
            print(f"  {a.label}: (none) -> {INITIAL}")

    if args.plugin:
        content = [p for p in proposals if p.body_changed and p.status == "M"]
        level = max_level([p.level for p in content]) if content else PATCH
        target = increment(plugin_version() or INITIAL, level)
        if set_plugin_version(target):
            print(f"  plugin: -> {target} [{level}]")
            marketplace_command(check=False)

    print(f"\nWrote {written} version field(s). "
          f"Re-run: python sdlc-suite/tools/generate_trees.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
