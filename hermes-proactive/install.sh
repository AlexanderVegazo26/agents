#!/usr/bin/env bash
# install.sh — wire hermes-proactive into ~/.hermes (idempotent).
#
#   scripts  -> copied to ~/.hermes/scripts/         (hermes cron only runs scripts from there)
#   skills   -> symlinked into ~/.hermes/skills/     (repo stays source of truth)
#   state    -> ~/.hermes/{monitors,goals,state/...} created
#
# After install:
#   1. systemd:  systemctl --user enable --now hermes-triggerd
#   2. monitors: condition_monitor.py add ...  (see skills/watch)
#   3. cron:     hermes cron create ...        (see README "Wiring")
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HS="$HOME/.hermes"

mkdir -p "$HS/monitors" "$HS/goals" "$HS/state/monitors" "$HS/skills"

for s in condition_monitor.py triggerd.py proactive_scan.py goals.py; do
    install -m 0755 "$SRC/$s" "$HS/scripts/$s"
    echo "installed script $s"
done

mkdir -p "$HS/scripts/hp"
install -m 0644 "$SRC/hp/__init__.py" "$HS/scripts/hp/__init__.py"
install -m 0644 "$SRC/hp/notify.py" "$HS/scripts/hp/notify.py"
echo "installed hp/ package"

# cron wrappers (hermes --script takes a single filename, no args)
for w in watchdog_run proactive_digest; do
    install -m 0755 "$SRC/wrappers/$w.sh" "$HS/scripts/$w.sh"
    echo "installed wrapper $w.sh"
done

for sk in watch trigger proactive-scan goals; do
    ln -sfn "$SRC/skills/$sk" "$HS/skills/$sk"
    echo "linked skill $sk"
done

[ -f "$HS/triggers.json" ] || cat > "$HS/triggers.json" <<'EOF'
{
  "host": "127.0.0.1",
  "port": 8471,
  "rules": []
}
EOF

mkdir -p "$HOME/.config/systemd/user"
if [ -f "$SRC/systemd/hermes-triggerd.service" ] && [ "${1:-}" = "--systemd" ]; then
    install -m 0644 "$SRC/systemd/hermes-triggerd.service" "$HOME/.config/systemd/user/"
    systemctl --user daemon-reload || true
    echo "systemd unit installed (enable with: systemctl --user enable --now hermes-triggerd)"
fi

echo "done. secrets for triggers go in ~/.hermes/.env as TRIGGER_SECRET_<NAME>=<random>"
