#!/usr/bin/env python3
"""Validate an autonomy policy against sdlc-suite/autonomy.schema.json.

    python sdlc-suite/tools/validate-autonomy.py sdlc-suite/autonomy.json
    python sdlc-suite/tools/validate-autonomy.py --all      # every policy in the repo

Why a hand-rolled checker rather than `jsonschema`
--------------------------------------------------
This repository has no `package.json` and no `requirements.txt`, so it has no
dependency floor at all. Adding one — for any reason, including this — fires the
`security-engineer` trigger in the routing policy and gives every adopter a new
install step. A thirty-line config does not justify that.

So `autonomy.schema.json` stays the published contract, and this file and
`workflows/_policy.js` each implement it. That is two mirrors of one spec, which
is a real cost; `--selftest` exists to keep them honest by asserting the gate
names here match the schema file exactly.

What it is actually catching
----------------------------
`additionalProperties: false` on the gate objects. An unknown key must be an
error rather than a silent absence, because absence is read as "not authorized":

- On the eight `act` gates that fails safe.
- On the five `decide` gates that are meant to be ON, a typo silently revokes
  authorization the run was given, and nothing distinguishes a typo from a
  deliberate lockdown.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCHEMA_PATH = ROOT / "sdlc-suite" / "autonomy.schema.json"


def load_schema() -> dict:
    return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


def _allowed(schema: dict, *path: str) -> list[str]:
    node = schema
    for p in path:
        node = node["properties"][p]
    return [k for k in node.get("properties", {}) if k != "$comment"]


def validate(policy, schema: dict) -> list[str]:
    errors: list[str] = []
    if not isinstance(policy, dict):
        return ["policy is not a JSON object"]

    top = set(schema["properties"]) | {"$comment"}
    for k in policy:
        if k not in top:
            errors.append(f"unknown top-level property: {k}")
    for k in schema.get("required", []):
        if k not in policy:
            errors.append(f"missing required property: {k}")

    for key in ("mode", "onBlocked"):
        if key in policy:
            allowed = schema["properties"][key]["enum"]
            if policy[key] not in allowed:
                errors.append(f"{key} must be one of {' | '.join(allowed)}, got {policy[key]!r}")

    pa = policy.get("preAuthorized")
    if isinstance(pa, dict):
        for k in pa:
            if k not in ("decide", "act"):
                errors.append(f"unknown preAuthorized class: {k}")
        for cls in ("decide", "act"):
            if cls not in pa:
                errors.append(f"missing preAuthorized.{cls}")
                continue
            obj = pa[cls]
            if not isinstance(obj, dict):
                errors.append(f"preAuthorized.{cls} is not an object")
                continue
            allowed = _allowed(schema, "preAuthorized", cls)
            for k, v in obj.items():
                if k == "$comment":
                    continue
                if k not in allowed:
                    near = next((g for g in allowed if g[:4].lower() == k[:4].lower()), None)
                    errors.append(
                        f"unknown gate preAuthorized.{cls}.{k}"
                        + (f" — did you mean {near}?" if near else "")
                    )
                elif not isinstance(v, bool):
                    errors.append(
                        f"preAuthorized.{cls}.{k} must be a boolean, got {type(v).__name__}"
                    )
    elif "preAuthorized" in policy:
        errors.append("preAuthorized is not an object")

    esc = policy.get("escalation")
    if isinstance(esc, dict):
        allowed_esc = set(schema["properties"]["escalation"]["properties"]) | {"$comment"}
        for k in esc:
            if k not in allowed_esc:
                errors.append(f"unknown escalation property: {k}")
        if "channel" in esc:
            allowed_ch = schema["properties"]["escalation"]["properties"]["channel"]["enum"]
            if esc["channel"] not in allowed_ch:
                errors.append(
                    f"escalation.channel must be one of {' | '.join(allowed_ch)}, "
                    f"got {esc['channel']!r}"
                )
    elif "escalation" in policy:
        errors.append("escalation is not an object")

    return errors


def summarise(policy: dict, schema: dict) -> str:
    d = policy.get("preAuthorized", {}).get("decide", {})
    a = policy.get("preAuthorized", {}).get("act", {})
    # Count what the FILE has, not what the schema allows. These used to be
    # schema constants, so deleting a gate printed "6 decide gates (4
    # authorized)" over a file holding five — reading as "a gate was turned
    # off" rather than "a gate is gone". Review found it by deletion.
    nd = sum(1 for k in d if k != "$comment")
    na = sum(1 for k in a if k != "$comment")
    expect_d = len(_allowed(schema, "preAuthorized", "decide"))
    expect_a = len(_allowed(schema, "preAuthorized", "act"))
    don = sum(1 for k, v in d.items() if k != "$comment" and v is True)
    aon = sum(1 for k, v in a.items() if k != "$comment" and v is True)
    missing = []
    if nd != expect_d:
        missing.append(f"{expect_d - nd} decide gate(s) absent")
    if na != expect_a:
        missing.append(f"{expect_a - na} act gate(s) absent")
    note = f" — {'; '.join(missing)}, treated as NOT authorized" if missing else ""
    return (f"{nd} of {expect_d} decide gates ({don} authorized), "
            f"{na} of {expect_a} act gates ({aon} authorized){note}")


def selftest(schema: dict) -> int:
    """Assert the JS mirror and this checker agree with the schema on gate names.

    Two implementations of one spec drift. This reads the gate lists straight out
    of workflows/_policy.js rather than restating them, so the check cannot pass
    by agreeing with a copy of itself.
    """
    import re

    js = (ROOT / "sdlc-suite" / "workflows" / "_policy.js").read_text(encoding="utf-8")
    m = re.search(r"const GATES = \{(.*?)\n\}", js, re.S)
    if not m:
        print("FAIL: could not find GATES in workflows/_policy.js", file=sys.stderr)
        return 1
    ok = True
    for cls in ("decide", "act"):
        block = re.search(rf"{cls}: \[(.*?)\]", m.group(1), re.S)
        js_gates = set(re.findall(r"'([\w]+)'", block.group(1))) if block else set()
        schema_gates = set(_allowed(schema, "preAuthorized", cls))
        if js_gates != schema_gates:
            print(f"FAIL: {cls} gates differ between schema and _policy.js", file=sys.stderr)
            print(f"  only in schema:     {sorted(schema_gates - js_gates)}", file=sys.stderr)
            print(f"  only in _policy.js: {sorted(js_gates - schema_gates)}", file=sys.stderr)
            ok = False
    if ok:
        print("OK: schema and workflows/_policy.js agree on all 14 gate names")
    return 0 if ok else 1


def main() -> int:
    for s in (sys.stdout, sys.stderr):
        if hasattr(s, "reconfigure"):
            s.reconfigure(encoding="utf-8", errors="replace")

    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("paths", nargs="*", help="policy files to validate")
    ap.add_argument("--all", action="store_true", help="validate every autonomy.json in the repo")
    ap.add_argument("--selftest", action="store_true",
                    help="assert the schema and the JS mirror agree on gate names")
    args = ap.parse_args()

    schema = load_schema()

    if args.selftest:
        return selftest(schema)

    paths = [Path(p) for p in args.paths]
    if args.all or not paths:
        paths = sorted(p for p in ROOT.rglob("autonomy.json")
                       if ".git" not in p.parts and "nawi" not in p.parts[0:1])
    if not paths:
        print("no autonomy.json found", file=sys.stderr)
        return 1

    failed = 0
    for p in paths:
        rel = p.relative_to(ROOT) if p.is_absolute() and ROOT in p.parents else p
        try:
            policy = json.loads(p.read_text(encoding="utf-8"))
        except FileNotFoundError:
            print(f"FAIL {rel}: not found", file=sys.stderr)
            failed += 1
            continue
        except json.JSONDecodeError as e:
            print(f"FAIL {rel}: not valid JSON — {e}", file=sys.stderr)
            failed += 1
            continue

        errors = validate(policy, schema)
        if errors:
            failed += 1
            print(f"FAIL {rel}", file=sys.stderr)
            for e in errors:
                print(f"  {e}", file=sys.stderr)
        else:
            print(f"OK   {rel}: {summarise(policy, schema)}")

    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
