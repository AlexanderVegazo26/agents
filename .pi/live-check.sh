#!/usr/bin/env bash
# pi live check — the rerunnable checklist for the pi port of sdlc-suite.
#
# The offline guarantees (the extension selftest, .pi/validate.py, the repo
# gate suite) do not need this. What this proves is that the LIVE path works
# on this machine: the extension's tools actually dispatch real pi sessions,
# the sandbox actually runs, and the failure modes behave as documented.
#
# Items 3, 4, 5, 6 and 7 are automated (PASS / FAIL / SKIP with evidence).
# Items 1, 2, 8 and 9 are manual by nature — they need a provider key, a real
# target repository, a push, or another machine — and this script prints the
# exact procedure for each instead of pretending to check it.
#
# Usage:
#   .pi/live-check.sh               # everything that can run here
#   .pi/live-check.sh --offline-only  # model-free items only (4 and 6)
#
# Prerequisites: pi installed, its configured model up (probed first), node
# on PATH, python3 for the session-file accounting. Exit 0 only when every
# runnable item passed; SKIP and MANUAL never fail the run.

set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIB="$REPO/.pi/extensions/sdlc/lib.js"
PI_BIN="${PI_BIN:-$HOME/.pi/agent/bin/pi}"
NODE_BIN="$(command -v node || true)"
PYTHON_BIN="$(command -v python3 || true)"
TIMEOUT_BIN="$(command -v timeout || true)"
DBG="/tmp/sdlc-ext-debug.log"
SESSIONS_ROOT="$HOME/.pi/agent/sessions"

OFFLINE_ONLY=0
[ "${1:-}" = "--offline-only" ] && OFFLINE_ONLY=1

TMP="$(mktemp -d /tmp/pi-live-check.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

PASS_N=0; FAIL_N=0; SKIP_N=0; MANUAL_N=0
RESULTS=""

pass() { PASS_N=$((PASS_N+1)); RESULTS="${RESULTS}[${1}] ${2} PASS   ${3}\n"; printf '[%s] %-38s PASS   %s\n' "$1" "$2" "$3"; }
fail() { FAIL_N=$((FAIL_N+1)); RESULTS="${RESULTS}[${1}] ${2} FAIL   ${3}\n"; printf '[%s] %-38s FAIL   %s\n' "$1" "$2" "$3"; }
skip() { SKIP_N=$((SKIP_N+1)); RESULTS="${RESULTS}[${1}] ${2} SKIP   ${3}\n"; printf '[%s] %-38s SKIP   %s\n' "$1" "$2" "$3"; }
manual() { MANUAL_N=$((MANUAL_N+1)); RESULTS="${RESULTS}[${1}] ${2} MANUAL ${3}\n"; printf '[%s] %-38s MANUAL %s\n' "$1" "$2" "$3"; }

dbg_lines() {  # lines appended to the extension debug log since a marker
  local marker="$1"
  sed -n "/${marker}/,\$p" "$DBG" 2>/dev/null | tail -n +2
}

echo "== pi live check — repo: $REPO =="
echo "   node: $NODE_BIN ($(node --version 2>/dev/null || echo missing))"
echo "   pi:   $PI_BIN"
echo

if [ -z "$NODE_BIN" ]; then
  echo "FAIL: node is not on PATH — the model-free items need it."
  exit 2
fi
if [ ! -x "$PI_BIN" ]; then
  echo "FAIL: pi binary not found at $PI_BIN (set PI_BIN to override)."
  exit 2
fi
if [ ! -f "$LIB" ]; then
  echo "FAIL: extension library missing at $LIB"
  exit 2
fi
if [ -z "$TIMEOUT_BIN" ]; then
  echo "FAIL: coreutils 'timeout' not found — the wall-clock guards need it."
  exit 2
fi

# ---------------------------------------------------------------------------
# Preflight — the model answers. Everything that needs a live session is
# SKIPped (not failed) when it is down.
# ---------------------------------------------------------------------------
MODEL_OK=0
if [ "$OFFLINE_ONLY" -eq 1 ]; then
  echo "model: not probed (--offline-only)"
else
  echo "-- preflight: model probe"
  : > "$DBG"
  ping_out="$("$TIMEOUT_BIN" 180 "$PI_BIN" -p --approve --no-session "Reply with exactly: PONG" 2>&1)"
  if printf '%s' "$ping_out" | grep -q "PONG"; then
    MODEL_OK=1
    echo "   model answers (PONG)"
  else
    echo "   model did not answer — live items will SKIP, not FAIL"
    echo "   last output: $(printf '%s' "$ping_out" | tail -1 | head -c 200)"
  fi
  echo
fi

# ---------------------------------------------------------------------------
echo "== P0 — now, free, local model =="

# [3] parallel() concurrency — Promise.all means genuinely concurrent nested
# pi processes; prove two complete and both results come back through the
# parent.
if [ "$OFFLINE_ONLY" -eq 1 ]; then
  skip 3 "parallel() concurrency" "model required (run without --offline-only)"
elif [ "$MODEL_OK" -eq 0 ]; then
  skip 3 "parallel() concurrency" "model down"
else
  cat > "$TMP/pi-live-parallel.js" <<'EOF'
export const meta = { name: 'pi-live-parallel', description: 'pi live check: two concurrent sub-agents' }
const rs = await parallel(['alpha', 'beta'].map(s => () => agent('Reply with exactly: PROBE-' + s.toUpperCase(), { label: 'probe-' + s })))
return { results: rs }
EOF
  : > "$DBG"
  marker3="live-check-3-start"
  echo "$marker3" >> "$DBG"
  prompt3="Use the workflow tool exactly once, with scriptPath \"$TMP/pi-live-parallel.js\" and args {}. When it returns, reply with the JSON result it returned, and nothing else."
  out3="$(PI_SDLC_DEBUG=1 "$TIMEOUT_BIN" 480 "$PI_BIN" -p --approve --no-session "$prompt3" 2>&1)"
  spawns3="$(dbg_lines "$marker3" | grep -c 'route=pty' || true)"
  if printf '%s' "$out3" | grep -q "PROBE-ALPHA" && printf '%s' "$out3" | grep -q "PROBE-BETA"; then
    pass 3 "parallel() concurrency" "both results relayed; $spawns3 nested pty spawns"
  else
    fail 3 "parallel() concurrency" "output: $(printf '%s' "$out3" | tail -1 | head -c 300)"
  fi
fi

# [4] timeout + process-group kill — no model needed. A fake "pi" binary that
# never exits must be reaped as a whole group (script + shell + sleep) when
# the per-agent budget fires.
sleeper="$TMP/pi-live-check-sleeper"
printf '#!/bin/sh\nsleep 300\n' > "$sleeper"
chmod +x "$sleeper"
r4="$(env PI_BIN="$sleeper" SDLC_LIB="$LIB" "$TIMEOUT_BIN" 60 "$NODE_BIN" -e '
  import(process.env.SDLC_LIB).then(async (m) => {
    const t0 = Date.now();
    const r = await m.spawnPi({ prompt: "x", extraArgs: [], cwd: process.cwd(), timeoutMs: 6000 });
    console.log(JSON.stringify({ timedOut: r.timedOut, spawnError: r.spawnError, ms: Date.now() - t0 }));
  }).catch((e) => { console.log(JSON.stringify({ error: String(e) })); process.exit(3); });
' 2>&1)"
sleep 2
leftovers="$(pgrep -f 'pi-live-check-sleeper' | wc -l | tr -d ' ')"
ms4="$(printf '%s' "$r4" | sed -n 's/.*"ms":\([0-9]*\).*/\1/p')"
if printf '%s' "$r4" | grep -q '"timedOut":true' && [ -n "$ms4" ] && [ "$ms4" -lt 20000 ] && [ "$leftovers" -eq 0 ]; then
  pass 4 "timeout + group kill" "$r4; 0 leftover processes"
else
  fail 4 "timeout + group kill" "$r4; leftovers=$leftovers $(pgrep -af 'pi-live-check-sleeper' 2>/dev/null | head -2 | tr '\n' ' ')"
fi

# [7] live-parent session hygiene — the parent runs WITHOUT --no-session (a
# real session), so the nested dispatch must not attach to it. Evidence: the
# parent session file holds exactly one user turn, and the extension's debug
# log records which session markers it stripped from the child env.
if [ "$OFFLINE_ONLY" -eq 1 ]; then
  skip 7 "live-parent session hygiene" "model required (run without --offline-only)"
elif [ "$MODEL_OK" -eq 0 ]; then
  skip 7 "live-parent session hygiene" "model down"
elif [ -z "$PYTHON_BIN" ]; then
  skip 7 "live-parent session hygiene" "python3 not found (session accounting)"
else
  start7="$(date +%s)"
  : > "$DBG"
  marker7="live-check-7-start"
  echo "$marker7" >> "$DBG"
  prompt7='Call the agent tool with name "qa-engineer" and task "Reply with exactly: DISPATCHED-LIVE-OK". Then reply with exactly PARENT-DONE and nothing else.'
  out7="$(PI_SDLC_DEBUG=1 "$TIMEOUT_BIN" 360 "$PI_BIN" -p --approve "$prompt7" 2>&1)"
  session_file="$(find "$SESSIONS_ROOT" -name '*.jsonl' -newermt "@$start7" 2>/dev/null | while read -r f; do
    head -1 "$f" | grep -q "\"cwd\":\"$REPO\"" && echo "$f" && break
  done | head -1)"
  user_turns=""
  if [ -n "$session_file" ]; then
    user_turns="$(python3 - "$session_file" <<'EOF'
import json, sys
n = 0
for line in open(sys.argv[1]):
    try: j = json.loads(line)
    except Exception: continue
    if j.get("type") == "message" and isinstance(j.get("message"), dict) \
            and j["message"].get("role") == "user":
        n += 1
print(n)
EOF
)"
  fi
  stripped="$(dbg_lines "$marker7" | grep -o 'stripped session markers: [A-Z_,]*' | head -1)"
  if printf '%s' "$out7" | grep -q "DISPATCHED-LIVE-OK" \
     && printf '%s' "$out7" | grep -q "PARENT-DONE" \
     && [ "$user_turns" = "1" ]; then
    note="parent session intact (1 user turn"
    [ -n "$stripped" ] && note="$note; $stripped)" || note="$note; no PI_SESSION* markers present in parent env)"
    pass 7 "live-parent session hygiene" "$note"
  else
    fail 7 "live-parent session hygiene" "user_turns=${user_turns:-no-session-file}; out: $(printf '%s' "$out7" | tail -1 | head -c 200)"
  fi
fi

# ---------------------------------------------------------------------------
echo
echo "== P1 — cheap setup =="

# [5] node < 26 direct route — the non-PTY spawn path, unexercised on a
# node-26-only machine. Needs a node 22 (nvm install 22); then the SELFTEST
# under it, and one live dispatch that must log route=direct.
n22=""
for c in "$HOME"/.nvm/versions/node/v22*/bin/node; do [ -x "$c" ] && n22="$c" && break; done
if [ -z "$n22" ] && command -v node22 >/dev/null 2>&1; then n22="$(command -v node22)"; fi
if [ -z "$n22" ]; then
  skip 5 "node 22 direct route" "no node 22 found — nvm install 22, then re-run"
else
  if ! "$n22" "$LIB" --selftest > "$TMP/n22-selftest.log" 2>&1; then
    fail 5 "node 22 direct route" "selftest failed under node 22: $(tail -2 "$TMP/n22-selftest.log" | head -c 200)"
  elif [ "$OFFLINE_ONLY" -eq 1 ]; then
    skip 5 "node 22 direct route" "selftest OK under node 22; live dispatch needs the model"
  elif [ "$MODEL_OK" -eq 0 ]; then
    skip 5 "node 22 direct route" "selftest OK under node 22; model down"
  else
    bundle="$(ls -d "$HOME"/.pi/agent/install/releases/*/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js 2>/dev/null | sort | tail -1)"
    if [ -z "$bundle" ]; then
      skip 5 "node 22 direct route" "selftest OK under node 22; pi bundle not found under ~/.pi/agent/install/releases/"
    else
      : > "$DBG"
      marker5="live-check-5-start"
      echo "$marker5" >> "$DBG"
      prompt5='Call the agent tool with name "qa-engineer" and task "Reply with exactly: DISPATCHED-DIRECT-OK". Then reply with exactly PARENT-DONE and nothing else.'
      out5="$(PI_SDLC_DEBUG=1 "$TIMEOUT_BIN" 360 "$n22" "$bundle" -p --approve --no-session "$prompt5" 2>&1)"
      direct="$(dbg_lines "$marker5" | grep -c 'route=direct' || true)"
      if printf '%s' "$out5" | grep -q "DISPATCHED-DIRECT-OK" && [ "$direct" -ge 1 ]; then
        pass 5 "node 22 direct route" "dispatch OK under $(basename "$(dirname "$(dirname "$n22")")"); $direct route=direct spawn(s)"
      else
        fail 5 "node 22 direct route" "direct_spawns=$direct; out: $(printf '%s' "$out5" | tail -1 | head -c 250)"
      fi
    fi
  fi
fi

# [6] no-`script` fail-fast — a restricted PATH without util-linux must fail
# in milliseconds with the fix named, not hang for the per-agent budget.
nopath="$TMP/nopath"
mkdir -p "$nopath"
ln -sf "$NODE_BIN" "$nopath/node"
ln -sf "$(command -v sh)" "$nopath/sh"
r6="$(env PATH="$nopath" PI_BIN="$PI_BIN" SDLC_LIB="$LIB" "$TIMEOUT_BIN" 20 "$NODE_BIN" -e '
  import(process.env.SDLC_LIB).then(async (m) => {
    const t0 = Date.now();
    const r = await m.spawnPi({ prompt: "x", extraArgs: [], cwd: process.cwd(), timeoutMs: 10000 });
    console.log(JSON.stringify({ exitCode: r.exitCode, spawnError: r.spawnError, timedOut: r.timedOut, ms: Date.now() - t0, msg: String(r.stderr).slice(0, 220) }));
  }).catch((e) => { console.log(JSON.stringify({ error: String(e) })); process.exit(3); });
' 2>&1)"
if printf '%s' "$r6" | grep -q '"spawnError":true' && printf '%s' "$r6" | grep -q '"timedOut":false' \
   && printf '%s' "$r6" | grep -q 'PTY route' \
   && [ "$(printf '%s' "$r6" | sed -n 's/.*"ms":\([0-9]*\).*/\1/p')" -lt 3000 ]; then
  pass 6 "no-\`script\` fail-fast" "$r6"
else
  fail 6 "no-\`script\` fail-fast" "$r6"
fi

# [8] CI on Actions — the validate job runs the extension selftest on node
# 20, a runtime this machine does not have. A push is required; this is a
# human decision, not a check.
manual 8 "CI on Actions (node 20)" "git push a branch, watch the validate job — the selftest must pass on node 20"

# ---------------------------------------------------------------------------
echo
echo "== P2 — the real proof (manual: provider key / target repo) =="

# [1] real provider — model: sonnet honored via --model, and the
# model-unavailable fallback (retry without --model). Only covered by the
# stubbed spawner offline.
manual 1 "real provider dispatch" "
  1. configure pi for a real provider (API key in env or pi config),
  2. PI_SDLC_DEBUG=1 pi -p --approve 'Call the agent tool with name
     qa-engineer and task Reply with exactly REAL-PROVIDER-OK. Then reply
     PARENT-DONE.'
  3. the debug log must show the --model argument taken from the role file;
     the fallback (drop --model, retry on the default) must appear only when
     that model is actually unavailable in the child environment."

# [2] full workflow command — a real sdlc-suite/workflows/*.js end-to-end.
# Probes have been run; the real pipelines are long and model-quality-
# sensitive, so this is a scheduled manual run, not an automated check.
manual 2 "full workflow command" "
  pi -p --approve 'Use the workflow tool exactly once, with scriptPath
  sdlc-suite/workflows/release-readiness.js and args {}. When it returns,
  report the pipeline result JSON.'
  Expected: tens of minutes (nested agents serialize on a single-slot
  model); pass = a result object with the pipeline's own gate table, and no
  'workflow threw' / null results for completed phases."

# [9] fresh machine / clean pi config — no local-model quirks.
manual 9 "fresh machine" "
  clone the repo in a container or second machine, install pi, point it at
  any provider, run: .pi/live-check.sh
  Everything automated here must PASS with no machine-specific state."

# ---------------------------------------------------------------------------
echo
echo "== result =="
printf '%b' "$RESULTS"
if [ "$FAIL_N" -gt 0 ]; then
  echo "RESULT: FAIL — $PASS_N passed, $FAIL_N failed, $SKIP_N skipped, $MANUAL_N manual"
  exit 1
fi
echo "RESULT: PASS — $PASS_N passed, $SKIP_N skipped, $MANUAL_N manual (manual items are procedures, not checks)"
exit 0
