#!/usr/bin/env bash
set -euo pipefail
ROOT=${WASHOI_ROOT:-/srv/washoi}
STATE="$ROOT/.deploy-state"
[[ -f "$STATE/pending.sha" ]] || exit 0
exec 9<>"$STATE/deploy.lock"
flock -n 9 || exit 0
# A published update replaces the running version even with connected players.
install -m 644 /dev/null "$ROOT/.maintenance"
trap 'rm -f "$ROOT/.maintenance"' EXIT
sha=$(cat "$STATE/pending.sha")
[[ $sha =~ ^[0-9a-f]{40}$ ]]
stage="$ROOT/.pending/$sha"
test -s "$stage/client/index.html"
test -s "$stage/server/lobby-server.mjs"
# File publication runs without root privileges. Only systemd restarts need root.
sudo -u washoi rsync -a --delete "$stage/server/" "$ROOT/repos/shag/dist-server/"
sudo -u washoi rsync -a --delete --exclude data/ "$stage/client/" "$ROOT/releases/game/"
if [[ -d $stage/client/data ]]; then
  sudo -u washoi rsync -a --exclude demos/ --exclude washoi_textures.pk3 "$stage/client/data/" "$ROOT/releases/game/data/"
fi
systemctl restart washoi-lobby washoi-bots
sleep 3
systemctl is-active --quiet washoi-lobby washoi-bots
sudo -u washoi /bin/bash -c 'printf "%s\n" "$1" > "$2/game.sha"; rm "$2/pending.sha"' -- "$sha" "$STATE"
echo "activated $sha"
