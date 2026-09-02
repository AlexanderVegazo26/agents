#!/usr/bin/env python3
"""Common utilities for Kimi Code workflow scripts.

NO WORKTREE ISOLATION HERE. The commandcode-suite port isolates each build
agent in its own detached git worktree (`withWorktree` in
../../commandcode-suite/workflows/_runner.js); this port has no equivalent,
and none of the workflows here asks for one. So the three build agents that
`sdlc-feature.py` launches concurrently through `parallel()` all write to the
caller's single working tree at the same time. A whole-tree git operation by
one builder acts on another's in-flight edits, and a shared check can go red
for reasons belonging to a different agent.

This is a known, accepted gap rather than an oversight — recorded here so it
is not rediscovered as a surprise. Closing it means adding the helper AND
wiring it into the build phase of sdlc-feature.py; adding the helper alone
would leave dead code that nothing calls.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence


# Location of the suite itself (resolved from this file, independent of cwd),
# so the workflows can be run against ANY repository as a global tool wallet.
KIMI_CODE = Path(__file__).resolve().parent.parent
AGENTS_DIR = KIMI_CODE / "agents"


def _kimi_bin() -> str:
    """Resolve the Kimi Code CLI binary.

    Priority: $KIMI_BIN env var -> standalone Kimi Code (~/.kimi-code/bin/kimi,
    or kimi.exe on Windows) -> 'kimi' from PATH. The standalone is preferred over
    PATH because PATH may resolve to the legacy Python kimi-cli, which cannot
    read Markdown agent files.
    """
    if os.environ.get("KIMI_BIN"):
        return os.environ["KIMI_BIN"]
    for name in ("kimi", "kimi.exe"):
        standalone = Path.home() / ".kimi-code" / "bin" / name
        if standalone.exists():
            return str(standalone)
    return "kimi"


KIMI_BIN = _kimi_bin()


@dataclass
class AgentResult:
    """Result from running a single agent."""

    agent: str
    label: str
    output: str
    success: bool
    error: str | None = None


def agent(
    prompt: str,
    agent_name: str,
    label: str | None = None,
    timeout: int = 3600,
) -> AgentResult:
    """Run a single agent via the Kimi Code CLI.

    Uses `kimi -p --agent <name> <prompt>` for non-interactive execution.
    """
    label = label or agent_name
    agent_file = AGENTS_DIR / f"{agent_name}.md"
    if not agent_file.exists():
        return AgentResult(agent_name, label, "", False, f"Agent not found: {agent_file}")

    cmd = [KIMI_BIN]
    # Print mode (-p) is inherently non-interactive: the standalone CLI executes
    # tool calls without approval prompts, and rejects --yolo/--auto combined
    # with -p. $KIMI_APPROVAL_FLAG remains as an escape hatch for future versions.
    if os.environ.get("KIMI_APPROVAL_FLAG"):
        cmd.append(os.environ["KIMI_APPROVAL_FLAG"])
    cmd += [
        "--agent-file",
        str(agent_file),
        # NOTE: the prompt must be the -p value; a trailing positional arg is
        # rejected as an unknown command by the standalone CLI.
        "-p",
        prompt,
    ]

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            # Run against the caller's current directory (the target repo),
            # not the suite repo.
            cwd=Path.cwd(),
        )
        output = result.stdout.strip()
        if result.returncode != 0:
            return AgentResult(agent_name, label, output, False, result.stderr.strip())
        return AgentResult(agent_name, label, output, True)
    except subprocess.TimeoutExpired:
        return AgentResult(agent_name, label, "", False, f"Timeout after {timeout}s")
    except Exception as exc:
        return AgentResult(agent_name, label, "", False, str(exc))


def parallel(
    tasks: Iterable[Callable[[], AgentResult]],
    max_workers: int | None = None,
    labels: Sequence[str] | None = None,
) -> list[AgentResult]:
    """Run agent tasks in parallel and return results in SUBMISSION order.

    Submission order, not completion order: every caller in this suite zips the
    return value against its own submission-ordered list (see the `zip(...)`
    calls in sdlc-feature.py and independent-review.py), so a completion-ordered
    return silently attributes each result to the wrong agent. Tasks still run
    concurrently and are still collected as they complete — only the slot each
    result lands in is fixed by submission index.

    `labels` is optional and positional-parallel to `tasks`. It names the agent
    behind each thunk so that a thunk raising outside `agent()` still produces
    an attributable failure. Without it, a failed slot is named `task-<index>`,
    which the caller can still map back to its own submission list. It is never
    named "unknown": an unattributable failure cannot be counted against an
    agent by any per-agent failure policy.
    """
    tasks = list(tasks)
    if not tasks:
        return []
    names = list(labels) if labels is not None else []

    results: list[AgentResult | None] = [None] * len(tasks)
    with ThreadPoolExecutor(max_workers=max_workers or len(tasks)) as executor:
        futures = {executor.submit(task): i for i, task in enumerate(tasks)}
        for future in as_completed(futures):
            idx = futures[future]
            try:
                results[idx] = future.result()
            except Exception as exc:
                name = names[idx] if idx < len(names) else f"task-{idx}"
                results[idx] = AgentResult(name, name, "", False, str(exc))
    unfilled = [i for i, r in enumerate(results) if r is None]
    if unfilled:
        # as_completed() yields every future exactly once, so this cannot
        # happen. Raise rather than return a short list: silently dropping a
        # slot would re-create the off-by-one mispairing in every caller that
        # zips this return value against its own task list.
        raise RuntimeError(f"parallel(): submission slots {unfilled} were never filled")
    return results  # type: ignore[return-value]


def pipeline(
    items: Iterable[Any],
    stage: Callable[[Any], AgentResult],
    cross_check: Callable[[AgentResult, Any], list[AgentResult]] | None = None,
    max_workers: int | None = None,
) -> list[AgentResult | list[AgentResult]]:
    """Run items through a stage, optionally cross-checking each result immediately."""
    items = list(items)
    if not items:
        return []

    # Run stage in parallel
    stage_results = parallel([lambda item=item: stage(item) for item in items], max_workers)

    if cross_check is None:
        return stage_results

    # Cross-check each result after the whole stage completes. parallel()
    # returns in submission order, so this zip pairs each result with its
    # own item.
    final: list[AgentResult | list[AgentResult]] = []
    for result, item in zip(stage_results, items):
        if result.success:
            checks = cross_check(result, item)
            final.append(checks)
        else:
            final.append(result)
    return final


def log(message: str) -> None:
    """Print a workflow log line."""
    print(f"[workflow] {message}", file=sys.stderr)


def phase(name: str) -> None:
    """Print a phase header."""
    print(f"\n{'=' * 60}", file=sys.stderr)
    print(f"PHASE: {name}", file=sys.stderr)
    print(f"{'=' * 60}\n", file=sys.stderr)


def extract_json(text: str) -> dict[str, Any] | None:
    """Try to extract a JSON object from agent output."""
    # Look for JSON code blocks
    import re

    m = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if m:
        try:
            return json.loads(m.group(1))
        except json.JSONDecodeError:
            pass

    # Try the whole output
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # Try to find a JSON object in the text
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if m:
        try:
            return json.loads(m.group(0))
        except json.JSONDecodeError:
            pass

    return None


def format_findings(findings: list[dict[str, Any]]) -> str:
    """Format findings for downstream consumption."""
    return json.dumps(findings, indent=2, ensure_ascii=False)


def read_file(path: str | Path) -> str:
    """Read a file and return its contents."""
    return Path(path).read_text(encoding="utf-8")


def write_file(path: str | Path, content: str) -> None:
    """Write content to a file, creating parent directories."""
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")
