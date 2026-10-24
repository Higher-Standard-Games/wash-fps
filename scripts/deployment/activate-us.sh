#!/usr/bin/env bash
set -euo pipefail
ROOT=/srv/washoi
STATE="$ROOT/.deploy-state"
[[ -f "$STATE/pending.sha" ]] || exit 0
exec 9<>"$STATE/deploy.lock"
flock -n 9 || exit 0
# Caddy's upstream connections include waiting rooms; child processes include matches.
if ss -Hnt state established '( sport = :9000 )' | grep -q .; then
  echo 'activation deferred: lobby connections remain'
  exit 0
fi
main=$(systemctl show washoi-lobby -p MainPID --value)
cg=$(systemctl show washoi-lobby -p ControlGroup --value)
if [[ -n $cg && -f /sys/fs/cgroup$cg/cgroup.procs ]]; then
  while read -r pid; do
    if [[ $pid != "$main" ]]; then echo 'activation deferred: a match process remains'; exit 0; fi
  done <"/sys/fs/cgroup$cg/cgroup.procs"
fi
# Block new lobby handshakes while checking again for in-flight connections.
install -m 644 /dev/null "$ROOT/.maintenance"
trap 'rm -f /srv/washoi/.maintenance' EXIT
sleep 1
if ss -Hnt state established '( sport = :9000 )' | grep -q .; then
  echo 'activation deferred: a lobby connection arrived during the idle check'
  exit 0
fi
if [[ -n $cg && -f /sys/fs/cgroup$cg/cgroup.procs ]]; then
  while read -r pid; do
    if [[ $pid != "$main" ]]; then echo 'activation deferred: a match started during the idle check'; exit 0; fi
  done <"/sys/fs/cgroup$cg/cgroup.procs"
fi
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
sudo -u washoi /bin/bash -c 'printf "%s\n" "$1" > /srv/washoi/.deploy-state/game.sha; rm /srv/washoi/.deploy-state/pending.sha' -- "$sha"
echo "activated $sha"
