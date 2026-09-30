#!/usr/bin/env bash
# Run Codex with the sdlc suite on a local Qwen3.8-27B served by Ollama.
# POSIX twin of run-qwen-local.ps1; see that file for the reasoning.
#
#   .codex/run-qwen-local.sh                      # interactive
#   .codex/run-qwen-local.sh exec "Use the orchestrator agent to ..."
#
# Environment overrides: QWEN_SDLC_MODEL, QWEN_SDLC_OLLAMA_URL, QWEN_SDLC_CODEX_HOME.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/.." && pwd)"
model="${QWEN_SDLC_MODEL:-qwen3.8-27b-sdlc}"
ollama="${QWEN_SDLC_OLLAMA_URL:-http://localhost:11434}"
while [ "${ollama%/}" != "$ollama" ]; do ollama="${ollama%/}"; done

# Both values are written into TOML strings below. Allowlist, not denylist:
# a newline, quote or backslash would add keys to the config.
if ! [[ "$model" =~ ^[A-Za-z0-9._:/-]+$ ]]; then
    echo "QWEN_SDLC_MODEL may contain only letters, digits and . _ : / -: $model" >&2; exit 2
fi
if ! [[ "$ollama" =~ ^https?://[A-Za-z0-9._:/-]+$ ]]; then
    echo "QWEN_SDLC_OLLAMA_URL must be a plain http(s) URL: $ollama" >&2; exit 2
fi
codex_home="${QWEN_SDLC_CODEX_HOME:-$HOME/.codex-qwen}"
context_window=32768   # keep equal to num_ctx in Modelfile.qwen3.8-27b

if ! tags="$(curl -fsS --max-time 5 "$ollama/api/tags")"; then
    echo "Ollama is not reachable at $ollama. Start it, then retry." >&2
    exit 2
fi
# Case-insensitive fixed-string match on the quoted name, as the .ps1's
# -contains does. Lowercased with tr rather than grep -i: Git for Windows ships
# GNU grep 3.0, which aborts on -i combined with several -F patterns. A
# here-string, not a pipe, so grep -q exiting early cannot fail under pipefail.
lc() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
model_lc="$(lc "$model")"
if ! grep -qF -e "\"name\":\"$model_lc\"" -e "\"name\":\"$model_lc:latest\"" <<<"$(lc "$tags")"; then
    echo "Model '$model' is not in Ollama. Build it once:" >&2
    echo "  ollama pull qwen3.8:27b" >&2
    echo "  ollama create $model -f \"$here/Modelfile.qwen3.8-27b\"" >&2
    exit 2
fi

# Codex matches trust entries against the native path; on Windows that is the
# lowercased backslash form, which Git Bash's /c/... path is not.
trust_key="$repo"
if command -v cygpath >/dev/null 2>&1; then
    trust_key="$(cygpath -w "$repo" | tr '[:upper:]' '[:lower:]')"
fi
case "$trust_key" in
    *"'"*) echo "Repository path contains a single quote: $repo" >&2; exit 2 ;;
esac

# Trusting the repo makes Codex load project-scoped files from .codex/ (config,
# hooks, rules), some of which can run or approve commands. Allowlist what this
# repository ships there; anything else (a branch, a merge) stops the launch
# rather than being trusted silently. Keep in step with run-qwen-local.ps1.
known=" agents skills README.md Modelfile.qwen3.8-27b run-qwen-local.ps1 run-qwen-local.sh convert-agents.py sync-skills.py __pycache__ "
unknown=""
for p in "$here"/* "$here"/.[!.]* "$here"/..?*; do
    [ -e "$p" ] || continue
    n="${p##*/}"
    case "$known" in *" $n "*) ;; *) unknown="$unknown $n" ;; esac
done
if [ -n "$unknown" ]; then
    echo "Refusing to trust $repo: unexpected entries in .codex:$unknown. Review them first." >&2; exit 2
fi

header="# WRITTEN BY .codex/run-qwen-local"
config="$codex_home/config.toml"
# No config yet is fine for a new or empty directory, not for an existing Codex
# home that simply has no config.toml (auth.json, sessions, ...).
if { [ -e "$config" ] && [ "$(head -c ${#header} "$config")" != "$header" ]; } ||
   { [ ! -e "$config" ] && [ -d "$codex_home" ] && [ -n "$(ls -A "$codex_home")" ]; }; then
    echo "Refusing to overwrite $config: this launcher did not write it (is QWEN_SDLC_CODEX_HOME your real Codex home?)." >&2
    exit 2
fi
mkdir -p "$codex_home"
cat > "$config" <<EOF
# WRITTEN BY .codex/run-qwen-local.sh ON EVERY LAUNCH. Edits here are overwritten.
model = "$model"
model_provider = "qwen_local"
model_context_window = $context_window

[model_providers.qwen_local]
name = "Ollama (local Qwen)"
base_url = "$ollama/v1"
wire_api = "responses"
stream_idle_timeout_ms = 3600000
request_max_retries = 1
stream_max_retries = 1

[projects.'$trust_key']
trust_level = "trusted"
EOF

export CODEX_HOME="$codex_home"
exec codex -C "$repo" "$@"
