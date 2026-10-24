#!/usr/bin/env bash
set -euo pipefail
ROOT=/srv/washoi
export HOME="$ROOT"
source "$ROOT/workspace.sh"
cd "$ROOT/repos/shag"
mkdir -p "$ROOT/validation"
exec > >(tee "$ROOT/validation/headless.log") 2>&1
export SERVER_DATA_DIR="$ROOT/validation/server-data"
mkdir -p "$SERVER_DATA_DIR"
washoi_game run test:simulation
washoi_game run test:physics
washoi_game run server:tick
washoi_game run server:fuzz -- --ticks 1000
for map in washoi_dm2 washoi_dm5 washoi_dm11 washoi_amphi1 washoi_snd1; do
  washoi_game run cli:game -- --exec "bsp load $map; bsp info; quit"
done
washoi_game run cli:game -- --exec 'sim replay "W+CROUCH 60; JUMP 1; W 30"; quit'
# A separate project root prevents test matches or demos touching production data.
scratch="$ROOT/validation/runtime"
mkdir -p "$scratch/public/data" "$scratch/dist-server"
sha=$(cat "$ROOT/.deploy-state/pending.sha")
rsync -a "$ROOT/.pending/$sha/server/" "$scratch/dist-server/"
for name in node_modules src config package.json; do
  [[ -e $scratch/$name ]] || ln -s "$ROOT/repos/shag/$name" "$scratch/$name"
done
for item in "$ROOT/assets/data/"*; do
  name=$(basename "$item")
  [[ $name == demos ]] && continue
  [[ -e $scratch/public/data/$name ]] || ln -s "$item" "$scratch/public/data/$name"
done
cd "$scratch"
export GAME_PATH="$scratch/public/data"
node dist-server/ServerRuntimeProbe.mjs
echo 'HEADLESS VALIDATION PASSED'
