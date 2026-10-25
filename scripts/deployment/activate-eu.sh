#!/usr/bin/env bash
set -euo pipefail
ROOT=${WASHOI_ROOT:-/srv/washoi}
STATE="$ROOT/.deploy-state"
exec 9<>"$STATE/deploy.lock"
flock -n 9 || exit 0
[[ -s "$STATE/game.sha" ]] || exit 0
sha=$(cat "$STATE/game.sha")
[[ $sha =~ ^[0-9a-f]{40}$ ]]
[[ $(cat "$STATE/backend.sha" 2>/dev/null || true) != "$sha" ]] || exit 0
test -s "$ROOT/repos/shag/dist-server/lobby-server.mjs"
test -s "$ROOT/repos/shag/dist-server/bot-server.mjs"
systemctl restart washoi-lobby washoi-bots
sleep 3
systemctl is-active --quiet washoi-lobby washoi-bots
sudo -u washoi /bin/bash -c 'printf "%s\n" "$1" > "$2/backend.sha.tmp"; mv "$2/backend.sha.tmp" "$2/backend.sha"' -- "$sha" "$STATE"
echo "activated EU backend $sha"
