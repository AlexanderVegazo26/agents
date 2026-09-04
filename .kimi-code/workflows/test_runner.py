#!/usr/bin/env python3
"""Tests for runner.py orchestration helpers.

Run with pytest, or directly:  python test_runner.py  (exits non-zero on failure)

The `parallel()` tests here exist because CHG-13's defect is silent: every
caller of `parallel()` zips its return against a submission-ordered label list
(`sdlc-feature.py:182`, `:204`; `independent-review.py:97`, `:115`), so a
completion-ordered return mislabels findings with no error anywhere. The
staggered sleeps below guarantee completion order differs from submission
order; a test without that stagger would pass against the broken code.
"""

from __future__ import annotations

import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from runner import AgentResult, parallel  # noqa: E402


# The real 4-lens shape from sdlc-feature.py's Verify phase, in its real
# submission order. The sleeps are chosen so completion order is
# [qa, security, review, performance] -- exactly one fixed point (index 3),
# so a completion-ordered return mislabels 3 of the 4.
LENSES = [
    ("code-reviewer", "verify:review", 0.30),
    ("qa-engineer", "verify:qa", 0.10),
    ("security-engineer", "verify:security", 0.20),
    ("performance-engineer", "verify:performance", 0.40),
]

SUBMISSION_ORDER = [name for name, _, _ in LENSES]
EXPECTED_COMPLETION_ORDER = ["qa-engineer", "security-engineer", "code-reviewer", "performance-engineer"]


def _lens_tasks(completed: list[str], lock: threading.Lock):
    tasks = []
    for name, label, delay in LENSES:

        def task(name=name, label=label, delay=delay):
            time.sleep(delay)
            with lock:
                completed.append(name)
            return AgentResult(name, label, f"{name} output", True)

        tasks.append(task)
    return tasks


def test_stagger_actually_inverts_the_order():
    """Guard against the ordering test passing vacuously.

    If the sleeps did not actually reorder completion, the submission-order
    assertion below would hold even against a completion-ordered `parallel()`.
    """
    completed: list[str] = []
    lock = threading.Lock()
    parallel(_lens_tasks(completed, lock))
    assert completed == EXPECTED_COMPLETION_ORDER, (
        f"stagger did not produce the intended completion order: {completed}"
    )
    assert completed != SUBMISSION_ORDER, "completion order equals submission order; test proves nothing"


def test_parallel_returns_submission_order():
    """CHG-13: results must line up with the caller's own task list."""
    completed: list[str] = []
    lock = threading.Lock()
    results = parallel(_lens_tasks(completed, lock))
    assert [r.agent for r in results] == SUBMISSION_ORDER
    assert [r.label for r in results] == [label for _, label, _ in LENSES]


def test_parallel_pairs_results_with_caller_labels():
    """The live mispairing: zip(results, LENSES) in sdlc-feature.py / independent-review.py."""
    completed: list[str] = []
    lock = threading.Lock()
    results = parallel(_lens_tasks(completed, lock))
    paired = [(r.agent, name) for r, (name, _, _) in zip(results, LENSES)]
    assert paired == [(name, name) for name in SUBMISSION_ORDER]


def test_parallel_failure_keeps_its_submission_slot():
    """A raising thunk must not shift the other results out of position."""

    def ok(name: str, delay: float):
        def task():
            time.sleep(delay)
            return AgentResult(name, name, "", True)

        return task

    def boom():
        time.sleep(0.05)
        raise RuntimeError("thunk exploded")

    results = parallel([ok("a", 0.30), boom, ok("c", 0.10)])
    assert len(results) == 3
    assert results[0].agent == "a"
    assert results[2].agent == "c"
    assert results[1].success is False
    assert "thunk exploded" in (results[1].error or "")


def test_parallel_failure_is_attributable_without_labels():
    """CHG-13: the exception path must not erase which task failed.

    The old code substituted the literal string "unknown" for the agent name,
    which makes the failure unattributable -- CHG-19's per-agent breaker cannot
    count failures against an agent named "unknown".
    """

    def boom():
        raise RuntimeError("thunk exploded")

    def fine():
        return AgentResult("qa-engineer", "verify:qa", "", True)

    results = parallel([fine, boom])
    assert results[1].agent != "unknown", "failure was attributed to the literal string 'unknown'"
    assert results[1].agent == "task-1"
    assert results[1].label == "task-1"


def test_parallel_failure_carries_supplied_label():
    """With labels supplied, the real agent name survives the exception path."""

    def boom():
        raise RuntimeError("thunk exploded")

    def fine():
        return AgentResult("code-reviewer", "verify:review", "", True)

    results = parallel([fine, boom], labels=["code-reviewer", "security-engineer"])
    assert results[1].agent == "security-engineer"
    assert results[1].label == "security-engineer"
    assert results[1].success is False


def test_parallel_empty():
    assert parallel([]) == []


if __name__ == "__main__":
    import pytest

    raise SystemExit(pytest.main([__file__, "-v"]))
