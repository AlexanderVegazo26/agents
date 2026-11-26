#!/usr/bin/env bash
# Create the local Jitsi rig used to test the meeting bot without a human.
#
# Why local: the public meet.jit.si keeps the LOBBY on, so a guest bot waits forever for a
# moderator who never signs in ("Asking to join meeting… no moderators have yet arrived").
# A local rig with the lobby OFF starts the conference by itself: the first participant is
# the moderator. That makes the whole meeting-bot test — join, transcribe, speak, chat —
# runnable unattended, on a machine, at 2am.
#
# The rig lives on the Vexa docker network so the bot's browser (inside the vexa-lite
# container) reaches it by name: the web container carries the alias "jitsi.local", which
# the Vexa link parser accepts as a self-hosted Jitsi (it infers Jitsi from a host that
# contains "jitsi" or "meet").
#
#   create.sh              create the rig if it does not exist (idempotent)
#   create.sh --recreate   wipe it and create it again
#   create.sh --config     print the generated web config.js
#
# Start/stop: svc up jitsi / svc down jitsi
set -euo pipefail
D="$(cd "$(dirname "$0")" && pwd)"
NET="${JITSI_NET:-vexa-lite-net}"
WEB_IMAGE="${JITSI_WEB_IMAGE:-jitsi/web:web-1.0.9300-1}"
PROSODY_IMAGE="${JITSI_PROSODY_IMAGE:-jitsi/prosody:prosody-13.0.6}"
JICOFO_IMAGE="${JITSI_JICOFO_IMAGE:-jitsi/jicofo:jicofo-1.0-1184-1}"
JVB_IMAGE="${JITSI_JVB_IMAGE:-jitsi/jvb:jvb-2.3-297-gcdc92a16b-1}"
DOMAIN="${JITSI_DOMAIN:-meet.local}"
PORT="${JITSI_PORT:-8443}"
ALIAS="${JITSI_ALIAS:-jitsi.local}"
PROSODY_VOLUME="${JITSI_PROSODY_VOLUME:-vexa-jitsi-prosody}"
WEB_VOLUME="${JITSI_WEB_VOLUME:-vexa-jitsi-web}"
# TLS material for the rig: the bot only joins https:// meetings, so the rig serves TLS and
# the bot's browser trusts the CA (baked into the vexa-lite image by the voice patch).
TLS_DIR="${JITSI_TLS_DIR:-$HOME/.local/share/vexa-jitsi-tls}"

if [ "${1:-}" = "--recreate" ]; then
  for c in vexa-jitsi vexa-jitsi-prosody vexa-jitsi-jicofo vexa-jitsi-jvb; do
    docker rm -f "$c" >/dev/null 2>&1 || true
  done
  docker volume rm "$PROSODY_VOLUME" "$WEB_VOLUME" >/dev/null 2>&1 || true
fi

if docker inspect vexa-jitsi >/dev/null 2>&1; then
  echo "jitsi rig already exists (start it with: svc up jitsi)"
  exit 0
fi

docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null
docker volume create "$PROSODY_VOLUME" >/dev/null
docker volume create "$WEB_VOLUME" >/dev/null

# The web image builds /config/config.js at startup from its own defaults and APPENDS
# /config/custom-config.js if it is there (see /etc/s6-overlay/scripts/config). So the
# overrides go in as custom-config.js — the stock config stays intact and a Jitsi upgrade
# cannot leave us with a half-configured web app.
echo "creating the jitsi rig on $NET (alias $ALIAS)…"

docker run -d --name vexa-jitsi-prosody --restart=no --network "$NET" \
  --network-alias prosody \
  -e PROSODY_DOMAIN="$DOMAIN" \
  -e XMPP_DOMAIN="$DOMAIN" \
  -e XMPP_AUTH_DOMAIN="$DOMAIN" \
  -e XMPP_MUC_DOMAIN="muc.$DOMAIN" \
  -e XMPP_INTERNAL_MUC_DOMAIN="internal-muc.$DOMAIN" \
  -e XMPP_BOSH_URL_BASE="http://prosody:5280/bosh" \
  -e XMPP_AUTH_USER=meet -e XMPP_AUTH_PASSWORD=meet \
  -e JICOFO_AUTH_PASSWORD=jicofo \
  -e JVB_AUTH_PASSWORD=jvb \
  -e ENABLE_AUTH=0 -e ENABLE_PROMETHEUS=0 \
  -v "${PROSODY_VOLUME}:/config" \
  "$PROSODY_IMAGE" >/dev/null

docker run -d --name vexa-jitsi-jicofo --restart=no --network "$NET" \
  --network-alias jicofo \
  -e JICOFO_HOSTNAME=jicofo \
  -e XMPP_DOMAIN="$DOMAIN" \
  -e XMPP_AUTH_DOMAIN="$DOMAIN" \
  -e XMPP_MUC_DOMAIN="muc.$DOMAIN" \
  -e XMPP_INTERNAL_MUC_DOMAIN="internal-muc.$DOMAIN" \
  -e XMPP_CLIENT_PORT=5222 \
  -e XMPP_TRUSTED_DOMAIN="jicofo.$DOMAIN" \
  -e XMPP_INTERNAL_CLIENT_PORT=5269 \
  -e XMPP_INTERNAL_TRUSTED_DOMAIN="jicofo.internal.$DOMAIN" \
  -e JICOFO_AUTH_PASSWORD=jicofo \
  -e AUTH_ENABLED=false -e ENABLE_AUTH=0 -e ENABLE_PROMETHEUS=0 \
  "$JICOFO_IMAGE" >/dev/null

docker run -d --name vexa-jitsi-jvb --restart=no --network "$NET" \
  --network-alias jvb \
  -p "127.0.0.1:${JVB_PORT:-10000}:10000/udp" \
  -e JVB_HOSTNAME=jvb \
  -e JVB_PORT=10000 \
  -e JVB_AUTH_USER=jvb -e JVB_AUTH_PASSWORD=jvb \
  -e ENABLE_AUTH=0 -e ENABLE_PROMETHEUS=0 \
  "$JVB_IMAGE" >/dev/null

docker run -d --name vexa-jitsi --restart=no --network "$NET" \
  --network-alias "$ALIAS" \
  -p "127.0.0.1:${PORT}:8443" \
  -e ENABLE_AUTH=0 \
  -e ENABLE_RECORDING=0 \
  -e ENABLE_TRANSCRIPTIONS=0 \
  -e ENABLE_PREJOIN_PAGE=1 \
  -e ENABLE_LETSENCRYPT=0 \
  -e DISABLE_HTTPS=0 \
  -e DISABLE_HOST_CHECK=1 \
  -e ENABLE_TURN=0 \
  -e PUBLIC_URL="https://${ALIAS}:8443" \
  -e XMPP_DOMAIN="$DOMAIN" \
  -e XMPP_AUTH_DOMAIN="$DOMAIN" \
  -e XMPP_MUC_DOMAIN="muc.$DOMAIN" \
  -e XMPP_BOSH_URL_BASE="http://prosody:5280/bosh" \
  -v "${WEB_VOLUME}:/config" \
  -v "${TLS_DIR}/jitsi.crt:/config/keys/cert.crt:ro" \
  -v "${TLS_DIR}/jitsi.key:/config/keys/cert.key:ro" \
  -v "${D}/overrides.js:/config/custom-config.js:ro" \
  "$WEB_IMAGE" >/dev/null

echo "created the jitsi rig: https://${ALIAS}:${PORT} (in the docker network)  /  https://127.0.0.1:${PORT} (from the host)"
echo "start it with: svc up jitsi"
