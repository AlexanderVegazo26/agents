#!/usr/bin/env python3
"""Differential property test: the two autonomy validators must agree.

`autonomy.schema.json` has two hand-written mirrors, `validate-autonomy.py` (this
directory) and `validate()` in `workflows/_policy.js` (what the workflows run).
`validate-autonomy.py --selftest` only proves they agree on the gate NAMES. This
proves they agree on the VERDICTS: 600 seeded policies (the shipped one, then
0-4 mutations each: unknown and missing keys, near-miss gate typos, wrong types,
bad enum values, non-object sections) go through both, and each policy's error
list must match.

    python sdlc-suite/tools/test_autonomy_mirror.py     # exit 0 on pass, 1 on fail
    python sdlc-suite/tools/test_autonomy_mirror.py --seed 7 --runs 2000

Compared modulo two things that are presentation, not verdict: the error order
(JavaScript lists integer-like keys first) and the text after ", got " (Python
prints `'x'`/`int`, JavaScript `"x"`/`number`).

Seen red on its first run: _policy.js suggested `did you mean deploy?` for an
act key of `de` or the empty string (its near-miss compared the gate against
`startsWith(key[:4])`, and every gate starts with ''), where this checker
requires the first four letters to match.

Needs `node` on PATH (CI's validate job has it). No pytest: stdlib unittest,
exit code is the result, like the suites beside it.
"""

from __future__ import annotations

import argparse
import copy
import importlib.util
import json
import random
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
POLICY_JS = ROOT / "sdlc-suite" / "workflows" / "_policy.js"
SHIPPED = ROOT / "sdlc-suite" / "autonomy.json"

_spec = importlib.util.spec_from_file_location(
    "validate_autonomy", Path(__file__).with_name("validate-autonomy.py"))
va = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(va)

SEED = 20261109
RUNS = 600

# Reads policies as a JSON array on stdin, prints one error list per policy.
NODE_DRIVER = (
    "const p = require(process.argv[1]);"
    "let s = '';"
    "process.stdin.on('data', d => { s += d });"
    "process.stdin.on('end', () => {"
    "  process.stdout.write(JSON.stringify(JSON.parse(s).map(x => p.validate(x))));"
    "});"
)

# Picked through copy.deepcopy: a shared {} mutated in one policy leaked into others.
ODD_VALUES = [None, 0, 1, 1.5, "", "true", "yes", [], ["unattended"], {}, {"a": 1}, True, False]
ODD_KEYS = ["", "x", "1", "07", "Mode", "mode ", "__proto__", "constructor", "toString",
            "$comment ", "decide", "act", "channel"]


def gate_typo(rng: random.Random, gate: str) -> str:
    """A key a person might write for `gate`, sometimes the gate itself."""
    return rng.choice([
        gate[: rng.randint(0, 6)],                      # truncated, incl. '' and 1-3 letters
        gate.upper(),
        gate.lower(),
        gate + rng.choice(["s", "x", "_", " "]),
        gate[:-1] + "i",                                # deploy -> deploi
        gate[:4].upper() + gate[4:],
        "x" + gate,
        gate,
    ])


def mutate(rng: random.Random, pol: dict) -> object:
    """One mutation. Returns the (possibly replaced) policy."""
    gates = va.load_schema()["properties"]["preAuthorized"]["properties"]
    kind = rng.randrange(14)
    pa = pol.get("preAuthorized")
    cls = rng.choice(["decide", "act"])
    if kind == 0:
        pol[rng.choice(ODD_KEYS)] = copy.deepcopy(rng.choice(ODD_VALUES))
    elif kind == 1:
        pol.pop(rng.choice(["mode", "preAuthorized", "onBlocked", "escalation", "$comment"]), None)
    elif kind == 2:
        pol[rng.choice(["mode", "onBlocked"])] = copy.deepcopy(rng.choice(
            ODD_VALUES + ["unattended", "interactive", "halt", "record-and-continue", "Halt"]))
    elif kind == 3:
        pol["preAuthorized"] = copy.deepcopy(rng.choice(ODD_VALUES))
    elif kind == 4 and isinstance(pa, dict):
        pa[rng.choice(ODD_KEYS + ["Decide", "acts"])] = rng.choice([{}, {"deploy": True}, None])
    elif kind == 5 and isinstance(pa, dict):
        pa.pop(cls, None)
    elif kind == 6 and isinstance(pa, dict):
        pa[cls] = copy.deepcopy(rng.choice(ODD_VALUES))
    elif kind in (7, 8) and isinstance(pa, dict) and isinstance(pa.get(cls), dict):
        gate = rng.choice([g for g in gates[cls]["properties"] if g != "$comment"])
        pa[cls][gate_typo(rng, gate)] = rng.choice([True, False, True, 0, 1, "true", None])
    elif kind == 9 and isinstance(pa, dict) and isinstance(pa.get(cls), dict):
        keys = list(pa[cls])
        if keys:
            pa[cls][rng.choice(keys)] = copy.deepcopy(rng.choice(ODD_VALUES))
    elif kind == 10 and isinstance(pa, dict) and isinstance(pa.get(cls), dict):
        pa[cls]["$comment"] = rng.choice(["note", 3, None])
    elif kind == 11:
        pol["escalation"] = copy.deepcopy(rng.choice(ODD_VALUES + [{"channel": "file"}]))
    elif kind == 12 and isinstance(pol.get("escalation"), dict):
        esc = pol["escalation"]
        rng.choice([
            lambda: esc.pop("channel", None),
            lambda: esc.__setitem__("channel", copy.deepcopy(rng.choice(ODD_VALUES + ["both", "Both", "email"]))),
            lambda: esc.__setitem__(rng.choice(ODD_KEYS), "x"),
            lambda: esc.__setitem__("$comment", "c"),
        ])()
    elif kind == 13 and rng.random() < 0.25:
        return rng.choice([None, [], "policy", 3, [pol]])
    return pol


def generate(seed: int, runs: int) -> list:
    rng = random.Random(seed)
    shipped = json.loads(SHIPPED.read_text(encoding="utf-8"))
    out = [copy.deepcopy(shipped)]
    while len(out) < runs:
        pol: object = copy.deepcopy(shipped)
        for _ in range(rng.randint(0, 4)):
            if not isinstance(pol, dict):
                break
            pol = mutate(rng, pol)
        out.append(pol)
    return out


def normalise(errors: list[str]) -> list[str]:
    return sorted(e.split(", got ", 1)[0] for e in errors)


def js_verdicts(policies: list) -> list[list[str]]:
    node = shutil.which("node")
    if not node:
        raise unittest.SkipTest("node not on PATH")
    proc = subprocess.run([node, "-e", NODE_DRIVER, str(POLICY_JS)],
                          input=json.dumps(policies), capture_output=True, text=True,
                          timeout=60, check=False)
    if proc.returncode != 0:
        raise AssertionError(f"node driver exited {proc.returncode}: {proc.stderr.strip()}")
    return json.loads(proc.stdout)


class MirrorAgreement(unittest.TestCase):
    seed = SEED
    runs = RUNS

    def test_js_and_python_validators_return_the_same_errors_for_every_seeded_policy(self):
        schema = va.load_schema()
        policies = generate(self.seed, self.runs)
        js = js_verdicts(policies)
        self.assertEqual(len(js), len(policies), "node returned a different number of verdicts")

        mismatches = []
        for i, (pol, js_errs) in enumerate(zip(policies, js)):
            py_errs = va.validate(pol, schema)
            if normalise(py_errs) != normalise(js_errs):
                mismatches.append(
                    f"  run {i}: policy {json.dumps(pol)}\n"
                    f"    validate-autonomy.py: {py_errs}\n"
                    f"    _policy.js validate(): {js_errs}")
        if mismatches:
            self.fail(
                f"{len(mismatches)} of {len(policies)} policies got different verdicts "
                f"(seed {self.seed}; rerun: python sdlc-suite/tools/test_autonomy_mirror.py "
                f"--seed {self.seed} --runs {self.runs}). First 5:\n" + "\n".join(mismatches[:5]))

    def test_the_generator_covers_both_valid_and_every_error_family(self):
        # A differential test over policies that are all valid (or all broken the
        # same way) proves nothing; pin the spread so a generator edit can't hollow it.
        schema = va.load_schema()
        policies = generate(self.seed, self.runs)
        verdicts = [va.validate(p, schema) for p in policies]
        valid = sum(1 for v in verdicts if not v)
        self.assertGreaterEqual(valid, 60, f"only {valid} valid policies of {len(policies)}")
        self.assertGreaterEqual(len(policies) - valid, 300,
                                f"only {len(policies) - valid} invalid policies of {len(policies)}")
        families = ["policy is not a JSON object", "unknown top-level property",
                    "missing required property", "mode must be one of", "onBlocked must be one of",
                    "unknown preAuthorized class", "missing preAuthorized.", "is not an object",
                    "unknown gate", "did you mean", "must be a boolean",
                    "unknown escalation property", "escalation.channel must be one of"]
        text = "\n".join(e for v in verdicts for e in v)
        missing = [f for f in families if f not in text]
        self.assertEqual(missing, [], f"seed {self.seed}: no generated policy hit {missing}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--seed", type=int, default=SEED)
    ap.add_argument("--runs", type=int, default=RUNS)
    args, rest = ap.parse_known_args()
    MirrorAgreement.seed, MirrorAgreement.runs = args.seed, args.runs
    prog = unittest.main(argv=[sys.argv[0], *rest], exit=False, verbosity=2)
    return 0 if prog.result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
