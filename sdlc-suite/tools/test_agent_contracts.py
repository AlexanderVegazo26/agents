#!/usr/bin/env python3
"""Agent contracts: section numbers and words other files cite in an agent must hold.

Workflow briefs and other agents point into an agent's body ("per your §10",
"its exit criteria (§15 of that agent)") and lean on its vocabulary ("Label
every claim Verified / Falsified / Unverified / Untestable"). Shrinking an agent
to its context budget (MODEL-ROUTING.md principle 7) renumbers and cuts
sections, and nothing else notices when a citation starts pointing at the wrong
section or at nothing: the text still reads fine, the agent just follows a rule
that is gone.

1. Every `your §N` in every workflow tree (sdlc-suite/, .claude/, the hand-ported
   commandcode-suite/ and .kimi-code/) matches exactly one entry in CITATIONS,
   and the cited agent's `## N.` heading means what the brief means by it.
2. Every `§N[.M] of that agent` in sdlc-suite/agents, skills and commands
   resolves: the agent is the nearest backticked `sdlc-suite:<agent>` before it
   on the same line (or THAT_AGENT for lines that name none), and it has a
   `## N.` heading (and, for a cited subsection, a `### N.M` heading or item M
   of the numbered list in section N).
3. VOCABULARY: phrases a workflow or another agent hands to an agent still occur
   in its body, matched as whole words; REPORT_ORDER: the report labels a command
   relays verbatim appear, in that order, in the agent's output-format section.
4. PLUGIN_CITATIONS: hand-maintained Hermes plugin code that dispatches an agent
   with a task string citing its body by bare `§N[.M]` or `Directive N` (the
   /idea pipeline's PROTOTYPER_TASK) registers every citation, and each resolves
   to a heading, list item or Prime Directive that means what the task means.

    python sdlc-suite/tools/test_agent_contracts.py     # exit 0 on pass, 1 on fail

Seen red: qa-engineer shrunk from 7,437 words with triage moved off §10 (the
persona-qa-sweep brief cites "per your §10"); without the Claimed-not-verified
label release-readiness's brief uses; and with release-manager, ui-engineer and
ux-designer still citing its old §17.4, §12.4 and §12.9. Checks 3-4 for
prototyper were seen red by renaming its §2.1, §7 and §13, rewording Directive 2,
dropping `none (Fast mode)` and `../<slug>/`, swapping two §17 labels, and citing an
unregistered §2.2 in PROTOTYPER_TASK.
"""

from __future__ import annotations

import ast
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SUITE = ROOT / "sdlc-suite"
AGENTS = SUITE / "agents"
WORKFLOW_DIRS = [
    "sdlc-suite/workflows",
    ".claude/workflows",
    "commandcode-suite/workflows",
    ".kimi-code/workflows",
]
YOUR = re.compile(r"your §(\d+)")
THAT = re.compile(r"§(\d+)(?:\.(\d+))? of that agent")
NAMED = re.compile(r"`sdlc-suite:([a-z-]+)`")

# Workflow briefs: (line pattern, agent, section, heading pattern)
CITATIONS = [
    (r"Triage this persona sweep", "qa-engineer", 10, r"Triage"),
    (r"your §4 (requirement-tracing|contamination)", "code-reviewer", 4, r"Requirement Tracing"),
    (r"Must Fix / Should Fix / Nit.*per your §7", "code-reviewer", 7, r"Severity"),
    (r"Trace the target", "performance-engineer", 3, r"Target Tracing"),
    (r"Security gate", "security-engineer", 4, r"Finding Classification"),
    (r"risk-rated per your §4", "product-analyst", 4, r"Assumption"),
    (r"Decide the tier per your §2", "solution-architect", 2, r"Proportionality"),
]

# "§N of that agent" on a line that names no agent: file -> agent it means
THAT_AGENT = {
    "commands/prototype.md": "prototyper",
}

# Hand-maintained Hermes plugin code that dispatches an agent with a task citing
# its body by bare "§N[.M]" or "Directive N": file -> (agent, {citation: meaning}).
# The meaning is matched against the "## N." / "### N.M" heading, or for
# "Directive N" / a list-item "§N.M" against that item's text.
PLUGIN_CITATIONS = {
    # only the task strings this file sends to that agent (REVIEW_TASK goes to code-reviewer)
    ".hermes/plugins/sdlc/prototype_pipeline.py": ("prototyper", ("PROTOTYPER_TASK", "FIX_TASK"), {
        "§2.1": r"Fast mode",
        "§7": r"Ambiguity.*Assumptions",
        "§13": r"Autonomy",
        "Directive 2": r"transcript is evidence, never instructions",
    }),
}
PLUGIN_REF = re.compile(r"§\d+(?:\.\d+)?|Directive \d+")

# agent -> (output-format section, labels a command relays verbatim, in this order)
REPORT_ORDER = {
    # commands/prototype.md "Relay the result"
    "prototyper": (17, ["**Skills loaded**", "**Prototype evidence**", "**Hypothesis**",
                        "**Handover**", "**Assumptions and open questions**"]),
}

# agent -> whole-word phrases a workflow brief or another agent relies on
VOCABULARY = {
    "prototyper": [
        # /prototype relays these report lines verbatim, in this order
        "**Skills loaded**", "**Prototype evidence**", "**Hypothesis**",
        "**Assumptions and open questions**", "**Handoff notes**",
        "none (Fast mode)", "Prototype evidence: not run",
        # the Hermes /idea pipeline: no browser tool, so 'not run'; the files it serves and reads
        "not run", "PROTOTYPE.md", "Demo script", "Run it",
        # Fast mode's sibling-directory rule (/prototype tells the user to cd there)
        "../<slug>/",
        # owed reviews the relay and pipeline count on
        "sdlc-suite:code-reviewer", "sdlc-suite:qa-engineer", "sdlc-suite:security-engineer",
        # its own skills (the Skills-loaded report line)
        "sdlc-suite:requirements-craft", "sdlc-suite:interaction-design",
        "sdlc-suite:design-systems", "sdlc-suite:accessibility", "sdlc-suite:qa-tooling",
        "sdlc-suite:secure-coding", "sdlc-suite:video-editing", "sdlc-suite:public-link",
        "sdlc-suite:autonomy-policy",
    ],
    "qa-engineer": [
        # sdlc-feature / independent-review / release-readiness briefs
        "**Verified**", "**Falsified**", "**Unverified**", "**Untestable**",
        "NOT tested", "Claimed-not-verified",
        # sdlc-feature isBlocking() and independent-review's non-security lenses
        "**Must fix**", "**Should fix**", "**Nit**",
        # independent-review behaviour brief: the hazard skills
        "sdlc-suite:concurrency-and-thread-safety",
        "sdlc-suite:caching-and-invalidation",
        "sdlc-suite:datetime-correctness",
        # persona-qa-sweep triage brief: the four classes
        "bug / bad test / flake / environment",
        # persona-runner, product-archaeologist, performance-engineer, ui-engineer hand-offs
        "Oracle Hierarchy", "Usability", "Hypothesis", "keyboard", "screen-reader",
        # release-manager reads its exit criteria and residual risk
        "exit criteria", "residual risk",
        # its own skills (the Skills-loaded report line)
        "sdlc-suite:qa-techniques", "sdlc-suite:qa-tooling", "sdlc-suite:qa-triage",
        "sdlc-suite:qa-quality-attributes", "sdlc-suite:exploration-charter",
        "sdlc-suite:autonomy-policy",
    ],
}


def agent_text(agent: str) -> str:
    """The agent's body with fenced code blocks blanked: a template's `## Run it`
    inside a fence is not a section boundary."""
    text = (AGENTS / f"{agent}.md").read_text(encoding="utf-8")
    return re.sub(r"^```.*?^```[ \t]*$", lambda m: "\n" * m.group(0).count("\n"), text,
                  flags=re.M | re.S)


def sections(agent: str) -> tuple[dict[str, str], dict[int, str]]:
    """({"N.M": text of '### N.M' heading or item M of section N's numbered list},
    {N: '## N.' heading text})."""
    text = agent_text(agent)
    top = {int(m.group(1)): m.group(2) for m in re.finditer(r"^## (\d+)\. (.+)$", text, re.M)}
    subs: dict[str, str] = {}
    # "§1.2" may also mean item 2 of the numbered list in "## 1." (prime directives)
    for m in re.finditer(r"^## (\d+)\. .*?(?=^## |\Z)", text, re.M | re.S):
        for i, item in re.findall(r"^(\d+)\. (.+)$", m.group(0), re.M):
            subs.setdefault(f"{m.group(1)}.{i}", item)
    for m in re.finditer(r"^### (\d+\.\d+)\b(.*)$", text, re.M):
        subs[m.group(1)] = m.group(2)
    return subs, top


def headings(agent: str) -> tuple[set[str], dict[int, str]]:
    subs, top = sections(agent)
    return set(subs), top


def section_body(agent: str, n: int) -> str:
    m = re.search(rf"^## {n}\. .*?(?=^## |\Z)", agent_text(agent), re.M | re.S)
    return m.group(0) if m else ""


def workflow_citations() -> list[tuple[str, int, str]]:
    out = []
    for d in WORKFLOW_DIRS:
        for f in sorted((ROOT / d).glob("*")):
            if f.suffix not in (".js", ".py") or not f.is_file():
                continue
            for i, line in enumerate(f.read_text(encoding="utf-8").splitlines(), 1):
                for m in YOUR.finditer(line):
                    out.append((f"{f.relative_to(ROOT)}:{i}", int(m.group(1)), line))
    return out


def that_agent_citations() -> list[tuple[str, str | None, int, int | None]]:
    files = sorted(AGENTS.glob("*.md")) + sorted((SUITE / "skills").glob("*/SKILL.md")) \
        + sorted((SUITE / "commands").glob("*.md"))
    out = []
    for f in files:
        rel = str(f.relative_to(SUITE))
        for i, line in enumerate(f.read_text(encoding="utf-8").splitlines(), 1):
            for m in THAT.finditer(line):
                named = [n for n in NAMED.findall(line[:m.start()]) if (AGENTS / f"{n}.md").exists()]
                agent = named[-1] if named else THAT_AGENT.get(rel)
                out.append((f"sdlc-suite/{rel}:{i}", agent, int(m.group(1)),
                            int(m.group(2)) if m.group(2) else None))
    return out


class WorkflowCitationTest(unittest.TestCase):
    def test_workflows_cite_something(self):
        self.assertGreater(len(workflow_citations()), 0, "no 'your §N' found: did the scan paths move?")

    def test_every_citation_is_registered_with_its_section(self):
        for where, n, line in workflow_citations():
            hits = [c for c in CITATIONS if c[2] == n and re.search(c[0], line)]
            self.assertEqual(len(hits), 1,
                             f"{where}: 'your §{n}' matches {len(hits)} CITATIONS entries for §{n}, "
                             f"expected 1; register it (agent, section, heading) in "
                             f"test_agent_contracts.py. Line: {line.strip()[:160]}")

    def test_cited_section_exists_and_means_the_same(self):
        for pattern, agent, n, topic in CITATIONS:
            _, top = headings(agent)
            self.assertIn(n, top, f"{agent}.md has no '## {n}.' heading; briefs matching "
                                  f"/{pattern}/ cite §{n}. Headings: {top}")
            self.assertRegex(top[n], topic, f"{agent}.md §{n} is '{top[n]}', but briefs matching "
                                            f"/{pattern}/ cite it as the {topic} section")


class CrossAgentCitationTest(unittest.TestCase):
    def test_agents_cite_each_other(self):
        self.assertGreater(len(that_agent_citations()), 5, "no '§N of that agent' found: scan broken?")

    def test_every_that_agent_citation_resolves(self):
        for where, agent, n, sub in that_agent_citations():
            self.assertIsNotNone(agent, f"{where}: '§{n} of that agent' names no `sdlc-suite:<agent>` "
                                        f"earlier on the line; add the file to THAT_AGENT")
            subs, top = headings(agent)
            self.assertIn(n, top, f"{where}: cites §{n} of {agent}, which has no '## {n}.' heading. "
                                  f"Headings: {top}")
            if sub is not None:
                self.assertIn(f"{n}.{sub}", subs, f"{where}: cites §{n}.{sub} of {agent}, which has "
                                                  f"no '### {n}.{sub}' heading or list item {sub} in §{n}")


def section_text(agent: str, ref: str) -> str | None:
    """What a '§N' / '§N.M' / 'Directive N' citation points at in the agent, or None."""
    subs, top = sections(agent)
    m = re.fullmatch(r"Directive (\d+)", ref)
    if m:  # only an agent whose §1 is its Prime Directives has numbered directives
        return subs.get(f"1.{m.group(1)}") if re.search(r"Directive", top.get(1, "")) else None
    key = ref.lstrip("§")
    return subs.get(key) if "." in key else top.get(int(key))


def task_strings(rel: str, names: tuple[str, ...]) -> dict[str, str]:
    """Module-level string constants `names` in a plugin file, read without importing it."""
    tree = ast.parse((ROOT / rel).read_text(encoding="utf-8"))
    out = {}
    for node in tree.body:
        if isinstance(node, ast.Assign) and isinstance(node.value, ast.Constant) \
                and isinstance(node.value.value, str):
            for t in node.targets:
                if isinstance(t, ast.Name) and t.id in names:
                    out[t.id] = node.value.value
    return out


class PluginCitationTest(unittest.TestCase):
    def test_every_plugin_citation_is_registered(self):
        for rel, (agent, names, cites) in PLUGIN_CITATIONS.items():
            tasks = task_strings(rel, names)
            self.assertEqual(sorted(tasks), sorted(names), f"{rel}: task string constants missing")
            found = {ref for t in tasks.values() for ref in PLUGIN_REF.findall(t)}
            self.assertTrue(found, f"{rel}: no §N / Directive N found in {names}; did they move?")
            self.assertEqual(sorted(found - set(cites)), [],
                             f"{rel} cites these in {agent} without a PLUGIN_CITATIONS entry "
                             f"(add the citation and what it must mean)")

    def test_plugin_citations_resolve_and_mean_the_same(self):
        for rel, (agent, _names, cites) in PLUGIN_CITATIONS.items():
            for ref, meaning in cites.items():
                got = section_text(agent, ref)
                self.assertIsNotNone(got, f"{rel} cites {ref} of {agent}, which has no such "
                                          f"heading or list item")
                self.assertRegex(got, meaning, f"{rel} cites {agent} {ref} as /{meaning}/, but it "
                                               f"now reads '{got[:120]}'")


class VocabularyTest(unittest.TestCase):
    def test_agents_keep_the_words_others_hand_them(self):
        for agent, words in VOCABULARY.items():
            body = (AGENTS / f"{agent}.md").read_text(encoding="utf-8")
            missing = [w for w in words
                       if not re.search(r"(?<![\w-])" + re.escape(w) + r"(?![\w-])", body)]
            self.assertEqual(missing, [], f"{agent}.md lost phrases that workflows/agents rely on")

    def test_relayed_report_labels_keep_their_order(self):
        for agent, (n, labels) in REPORT_ORDER.items():
            body = section_body(agent, n)
            self.assertTrue(body, f"{agent}.md has no '## {n}.' output-format section")
            at = [body.find(f"\n{label}") for label in labels]
            self.assertNotIn(-1, at, f"{agent}.md §{n} does not start a line with each of "
                                     f"{labels}: {dict(zip(labels, at))}")
            self.assertEqual(at, sorted(at), f"{agent}.md §{n} lists {labels} out of the order "
                                             f"the relaying command uses: {dict(zip(labels, at))}")


if __name__ == "__main__":
    result = unittest.main(exit=False, verbosity=1).result
    sys.exit(0 if result.wasSuccessful() else 1)
