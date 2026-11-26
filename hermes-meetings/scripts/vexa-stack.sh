#!/usr/bin/env bash
# Vexa meeting-bot stack control for this machine.
#
# The stack is ON DEMAND: it is not started at boot (see the shutdown policy in
# the repo README). If Hermes cannot reach the Vexa MCP server, start it with:
#
#   ~/.hermes/scripts/vexa-stack.sh start
#
# "start" only ever runs `docker start` on the existing containers, so the
# known-good configuration is preserved verbatim:
#   - vexa-lite        image vexa-lite:v0.12.28-voice (local speak patch)
#   - vexa-lite-whisper  mobiuslabsgmbh/faster-whisper-large-v3-turbo, int8,
#                        offline HF cache mounted from ~/AI/models/hf
#   - vexa-lite-postgres / vexa-lite-storage / vexa-mcp
#
# Do NOT use `make -C deploy/lite up` for a routine restart: it recreates
# vexa-lite-whisper with the Makefile default model (tiny.en, English-only) and
# recreates vexa-lite from the unpatched upstream image, which breaks Spanish
# transcription and in-call speech. Rebuild from scratch only per the
# "Setup" section of hermes-meetings/README.md.
set -euo pipefail

GATEWAY_URL="http://127.0.0.1:8056"
STT_URL="http://127.0.0.1:8083"
MCP_PORT="18010"

# Start order matters: datastores, then STT, then the app, then the MCP proxy.
CONTAINERS=(
  vexa-lite-postgres
  vexa-lite-storage
  vexa-lite-whisper
  vexa-lite
  vexa-mcp
)

wait_http() {
  local url=$1 name=$2 attempts=${3:-36}
  for _ in $(seq 1 "$attempts"); do
    if [ "$(curl -sf -o /dev/null -w '%{http_code}' -m 3 "$url" || true)" = "200" ]; then
      echo "  ✓ $name ready"
      return 0
    fi
    sleep 5
  done
  echo "  ✗ $name NOT ready after $((attempts * 5))s — check: docker logs $name" >&2
  return 1
}

wait_port() {
  local port=$1 name=$2 attempts=${3:-24}
  for _ in $(seq 1 "$attempts"); do
    if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
      echo "  ✓ $name listening on 127.0.0.1:$port"
      return 0
    fi
    sleep 2
  done
  echo "  ✗ $name NOT listening on 127.0.0.1:$port — check: docker logs $name" >&2
  return 1
}

cmd_start() {
  echo "Starting Vexa stack..."
  local missing=()
  for c in "${CONTAINERS[@]}"; do
    if ! docker inspect "$c" >/dev/null 2>&1; then
      missing+=("$c")
      continue
    fi
    if [ "$(docker inspect -f '{{.State.Running}}' "$c")" = "true" ]; then
      echo "  · $c already running"
      continue
    fi
    docker start "$c" >/dev/null
    echo "  ✓ $c started"
  done

  if [ ${#missing[@]} -gt 0 ]; then
    echo "ERROR: missing container(s): ${missing[*]}" >&2
    echo "Rebuild the stack per hermes-meetings/README.md (Setup section)." >&2
    return 1
  fi

  wait_http "$GATEWAY_URL/health" "gateway (8056)"
  wait_http "$STT_URL/health" "whisper STT (8083)"
  wait_port "$MCP_PORT" "vexa MCP (18010)"
  echo "Vexa stack is up."
}

cmd_stop() {
  echo "Stopping Vexa stack..."
  for c in vexa-mcp vexa-lite vexa-lite-whisper vexa-lite-storage vexa-lite-postgres; do
    if docker inspect "$c" >/dev/null 2>&1; then
      docker stop "$c" >/dev/null 2>&1 && echo "  ✓ $c stopped" || true
    fi
  done
  echo "Data volumes kept (vexa-lite-pgdata, vexa-lite-storagedata)."
}

cmd_status() {
  echo "Vexa containers:"
  for c in "${CONTAINERS[@]}"; do
    if docker inspect "$c" >/dev/null 2>&1; then
      printf '  %-22s %-10s restart=%s\n' "$c" \
        "$(docker inspect -f '{{.State.Status}}' "$c")" \
        "$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$c")"
    else
      printf '  %-22s %s\n' "$c" "MISSING"
    fi
  done
  echo "Endpoints:"
  printf '  gateway   %s\n' "$(curl -sf -o /dev/null -w '%{http_code}' -m 3 "$GATEWAY_URL/health" || echo down)"
  printf '  whisper   %s\n' "$(curl -sf -o /dev/null -w '%{http_code}' -m 3 "$STT_URL/health" || echo down)"
  if (exec 3<>"/dev/tcp/127.0.0.1/$MCP_PORT") 2>/dev/null; then echo "  mcp       up"; else echo "  mcp       down"; fi
}

case "${1:-status}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  status) cmd_status ;;
  *)
    echo "usage: $(basename "$0") {start|stop|status}" >&2
    exit 2
    ;;
esac
