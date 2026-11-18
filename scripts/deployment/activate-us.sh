#!/usr/bin/env bash
set -euo pipefail
ROOT=${WASHOI_ROOT:-/srv/washoi}
STATE="$ROOT/.deploy-state"
[[ -f "$STATE/pending.sha" ]] || exit 0
exec 9<>"$STATE/deploy.lock"
flock -n 9 || exit 0
# A published update replaces the running version even with connected players.
# As washoi, like the publication below: root writing into washoi's directory
# would follow a link planted there
sudo -u washoi install -m 644 /dev/null "$ROOT/.maintenance"
trap 'rm -f "$ROOT/.maintenance"' EXIT
sha=$(cat "$STATE/pending.sha")
[[ $sha =~ ^[0-9a-f]{40}$ ]]
stage="$ROOT/.pending/$sha"
test -s "$stage/client/index.html"
test -s "$stage/server/lobby-server.mjs"
# With washoi-bots disabled the lobby seats bots itself and needs the match
# runner: checked in the stage, before anything is published
services=(washoi-lobby)
if systemctl is-enabled --quiet washoi-bots 2>/dev/null; then
  services+=(washoi-bots)
else
  test -s "$stage/server/bot-runner.mjs"
fi
# File publication runs without root privileges. Only systemd restarts need root.
sudo -u washoi rsync -a --delete "$stage/server/" "$ROOT/repos/shag/dist-server/"
sudo -u washoi rsync -a --delete --exclude data/ "$stage/client/" "$ROOT/releases/game/"
if [[ -d $stage/client/data ]]; then
  sudo -u washoi rsync -a --exclude demos/ --exclude washoi_textures.pk3 "$stage/client/data/" "$ROOT/releases/game/data/"
fi
systemctl restart "${services[@]}"
sleep 3
systemctl is-active --quiet "${services[@]}"
sudo -u washoi /bin/bash -c 'printf "%s\n" "$1" > "$2/game.sha"; rm "$2/pending.sha"' -- "$sha" "$STATE"
echo "activated $sha"
# Each build stage is ~0.6 GB. Keep the activated stage and the newest earlier
# complete stage (it has revisions.json) for rollback; remove the rest.
previous=$(find "$ROOT/.pending" -mindepth 2 -maxdepth 2 -name revisions.json ! -path "*/$sha/*" -printf '%T@ %h\n' |
  sort -rn | head -n 1 | cut -d' ' -f2-)
shopt -s nullglob
for old in "$ROOT"/.pending/*/; do
  old=${old%/}
  [[ $old == "$stage" || $old == "$previous" ]] && continue
  rm -rf -- "$old"
done
