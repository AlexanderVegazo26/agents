"""Prove that every rule in .gitleaks.toml fires, and every allowlist excuses only
what it says it excuses, by scanning fixtures with the real gitleaks binary.

    python3 scripts/test_gitleaks_rules.py

The binary is $GITLEAKS, else `gitleaks` on PATH. Without one the tests skip,
unless GITLEAKS_REQUIRED=1 (CI's secrets job sets it, after installing the
pinned, checksum-verified release), where a missing binary is a failure.

Why this exists: a clean scan of the tree cannot tell "nothing to find" from
"the rule is dead". The private-project-name rule was dead from the day it was
written: its allowlist listed `regexes` and `paths` without `condition = "AND"`,
gitleaks ORs them by default, and the regex matched every hit the rule can
produce, so the name was excused in every file. A green CI job hid it, and one
occurrence slipped into docs/ meanwhile. Seen red by deleting that `condition`
line (the private-project tests fail, naming the file that was not flagged).

The fixture strings are assembled at runtime, so this file does not contain the
identifiers it plants and the tree scan does not flag it.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / ".gitleaks.toml"

EMPLOYER = "tap" + "check"
PROJECT = "na" + "wi"
VEX_ID = "FR-" + "VEX.1-14"
HOME_REAL = "/ho" + "me/realperson/notes"
WIN_REAL = "C:\\" + "Users\\otherguy\\notes"
HOME_PLACEHOLDERS = ["/ho" + "me/username/notes", "/Us" + "ers/you/notes"]
# The upstream github-pat rule, to prove the defaults are still loaded and that
# --redact keeps the value out of the (public) log.
TOKEN = "gh" + "p_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"

# The project-name rule's allowlisted paths, copied from .gitleaks.toml.
PROJECT_EXCUSED = [
    "docs/platform-review-2026-09-01.md",
    "docs/platform-review-2026-09-01-corrections.md",
    ".gitignore",
    "CLAUDE.md",
    "CHANGELOG.md",
    "sdlc-suite/tools/eol_check.py",
    "sdlc-suite/tools/validate-autonomy.py",
]


def gitleaks_binary() -> str | None:
    return os.environ.get("GITLEAKS") or shutil.which("gitleaks")


BINARY = gitleaks_binary()
REQUIRED = os.environ.get("GITLEAKS_REQUIRED") == "1"


class GitleaksRules(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if BINARY is None:
            if REQUIRED:
                raise AssertionError("GITLEAKS_REQUIRED=1 but no gitleaks binary "
                                     "(set $GITLEAKS or put gitleaks on PATH)")
            raise unittest.SkipTest("no gitleaks binary ($GITLEAKS or PATH); "
                                    "CI's secrets job runs these with the pinned release")
        version = subprocess.run([BINARY, "version"], capture_output=True, text=True)
        print(f"gitleaks {version.stdout.strip()} at {BINARY}")

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tree = Path(self._tmp.name) / "tree"
        self.tree.mkdir()
        self.addCleanup(self._tmp.cleanup)

    def write(self, rel: str, text: str) -> None:
        path = self.tree / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text + "\n", encoding="utf-8")

    def scan(self) -> tuple[subprocess.CompletedProcess, list[tuple[str, str]]]:
        """Scan the fixture tree with the repo config; return (process, sorted
        (rule, path) findings)."""
        report = Path(self._tmp.name) / "report.json"
        proc = subprocess.run(
            [BINARY, "dir", "--config", str(CONFIG), "--no-banner", "--redact",
             "--verbose", "--exit-code", "1", "--report-format", "json",
             "--report-path", str(report), str(self.tree)],
            capture_output=True, text=True, timeout=120,
        )
        self.assertIn(proc.returncode, (0, 1),
                      f"gitleaks itself failed (exit {proc.returncode}):\n{proc.stdout}{proc.stderr}")
        findings = json.loads(report.read_text() or "[]")
        hits = sorted((f["RuleID"], Path(f["File"]).relative_to(self.tree).as_posix())
                      for f in findings)
        return proc, hits

    def assertFlagged(self, hits, rule: str, rel: str) -> None:
        self.assertIn((rule, rel), hits,
                      f"expected rule {rule} to flag {rel}; actual findings: {hits}")

    def assertNotFlagged(self, hits, rule: str, rel: str) -> None:
        self.assertNotIn((rule, rel), hits,
                         f"expected rule {rule} to excuse {rel}; actual findings: {hits}")

    # --- repository identifier rules -----------------------------------------

    def test_employer_name_is_flagged_anywhere(self):
        self.write("README.md", f"we work at {EMPLOYER}")
        self.write("docs/notes.md", f"{EMPLOYER.upper()} said so")
        _, hits = self.scan()
        self.assertFlagged(hits, "agents-employer-name", "README.md")
        self.assertFlagged(hits, "agents-employer-name", "docs/notes.md")

    def test_private_project_name_is_flagged_outside_its_excused_files(self):
        self.write("README.md", f"built against {PROJECT}")
        self.write("docs/a-new-review.md", f"runs live in {PROJECT}/ only")
        self.write("sdlc-suite/agents/x.md", f"see {PROJECT}-vex for details")
        _, hits = self.scan()
        for rel in ("README.md", "docs/a-new-review.md", "sdlc-suite/agents/x.md"):
            self.assertFlagged(hits, "agents-private-project-name", rel)

    def test_private_project_name_is_excused_only_in_its_listed_files(self):
        for rel in PROJECT_EXCUSED:
            self.write(rel, f"mentions {PROJECT} on purpose")
        _, hits = self.scan()
        for rel in PROJECT_EXCUSED:
            self.assertNotFlagged(hits, "agents-private-project-name", rel)

    def test_excused_files_still_fail_on_every_other_rule(self):
        for rel in PROJECT_EXCUSED:
            self.write(rel, f"{PROJECT} and {EMPLOYER}")
        _, hits = self.scan()
        for rel in PROJECT_EXCUSED:
            self.assertFlagged(hits, "agents-employer-name", rel)

    def test_real_home_paths_are_flagged(self):
        self.write("unix.md", f"open {HOME_REAL}")
        self.write("windows.md", f"open {WIN_REAL}")
        _, hits = self.scan()
        self.assertFlagged(hits, "agents-absolute-home-path", "unix.md")
        self.assertFlagged(hits, "agents-absolute-home-path", "windows.md")

    def test_placeholder_home_paths_are_excused(self):
        for i, path in enumerate(HOME_PLACEHOLDERS):
            self.write(f"placeholder{i}.md", f"substitute your own path: {path}")
        _, hits = self.scan()
        for i, path in enumerate(HOME_PLACEHOLDERS):
            self.assertNotFlagged(hits, "agents-absolute-home-path", f"placeholder{i}.md")

    def test_requirement_ids_are_flagged(self):
        self.write("spec.md", f"implements {VEX_ID}")
        _, hits = self.scan()
        self.assertFlagged(hits, "agents-vex-requirement-id", "spec.md")

    # --- upstream defaults and the public log --------------------------------

    def test_upstream_rules_load_and_redact_keeps_the_secret_out_of_the_log(self):
        self.write("config.py", f'token = "{TOKEN}"')
        proc, hits = self.scan()
        self.assertFlagged(hits, "github-pat", "config.py")
        self.assertEqual(proc.returncode, 1, "a finding must fail the job (--exit-code 1)")
        log = proc.stdout + proc.stderr
        self.assertNotIn(TOKEN, log, "--redact must keep the secret out of the public log")
        for field in ("RuleID:", "File:", "Line:"):
            self.assertIn(field, log, f"--verbose output must name the {field[:-1]}")

    def test_clean_tree_passes(self):
        self.write("README.md", "nothing to see; substitute /home/<you>/ yourself")
        proc, hits = self.scan()
        self.assertEqual(hits, [], f"expected no findings; actual: {hits}")
        self.assertEqual(proc.returncode, 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
