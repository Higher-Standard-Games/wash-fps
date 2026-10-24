#!/usr/bin/env bash
set -euo pipefail
ROOT=/srv/washoi
if [[ $EUID -eq 0 ]]; then exec sudo -u washoi env HOME="$ROOT" "$0" "$@"; fi
export HOME="$ROOT"
cd "$ROOT"
mkdir -p "$ROOT/logs" "$ROOT/.deploy-state" "$ROOT/.pending"
exec 9>"$ROOT/.deploy-state/deploy.lock"
flock -n 9 || exit 0
find "$ROOT/logs" -maxdepth 1 -name 'deploy-*.log' -type f -mtime +14 -delete
LOG="$ROOT/logs/deploy-$(date -u +%Y%m%dT%H%M%SZ).log"
exec > >(tee -a "$LOG") 2>&1
trap 'echo "ERROR: deploy failed at line $LINENO"' ERR
source "$ROOT/workspace.sh"
result=0
if [[ ${1:-} == --initial ]]; then washoi_prepare --no-fetch || result=$?; else washoi_prepare || result=$?; fi
[[ $result != 75 ]] || exit 0
[[ $result == 0 ]] || { echo 'ERROR: workspace preparation failed'; exit 1; }
cd "$ROOT/repos/shag"
sha=$(washoi_pair_id)
active=$(cat "$ROOT/.deploy-state/game.sha" 2>/dev/null || true)
pending=$(cat "$ROOT/.deploy-state/pending.sha" 2>/dev/null || true)
if [[ ${1:-} != --force && ( $sha == "$active" || $sha == "$pending" ) ]]; then
  echo "unchanged: $sha"
  exit 0
fi
key=$(sha256sum package-lock.json | cut -d' ' -f1)
if [[ ! -d node_modules || $(cat "$ROOT/.deploy-state/npm-lock.sha" 2>/dev/null || true) != "$key" ]]; then
  ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --no-audit --no-fund
  printf '%s\n' "$key" >"$ROOT/.deploy-state/npm-lock.sha"
fi
[[ -L public/data && $(readlink -f public/data) == "$ROOT/assets/data" ]]
stage="$ROOT/.pending/$sha"
mkdir -p "$stage/client" "$stage/server"
washoi_game run build:server -- "$stage/server"
NODE_OPTIONS=--max-old-space-size=3072 VITE_LOBBY_URL=wss://us.washoi.net/lobby washoi_game run build
rsync -a --delete --exclude sourcemaps/ --exclude stats.html --exclude data/demos/ --exclude data/washoi_textures.pk3 dist/ "$stage/client/"
cp "$ROOT/.deploy-state/checkout-pair.json" "$stage/revisions.json"
test -s "$stage/client/index.html"
test -s "$stage/server/lobby-server.mjs"
test -s "$stage/server/bot-server.mjs"
test -s "$stage/server/headless-netserver-v2.mjs"
printf '%s\n' "$sha" >"$ROOT/.deploy-state/pending.sha.tmp"
mv "$ROOT/.deploy-state/pending.sha.tmp" "$ROOT/.deploy-state/pending.sha"
echo "built $sha; activation waits until no lobby connections or match processes remain"
