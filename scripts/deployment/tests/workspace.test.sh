#!/usr/bin/env bash
set -euo pipefail
source "${1:-$(dirname "$0")/../workspace.sh}"
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
export GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_AUTHOR_NAME=DeploymentQA GIT_COMMITTER_NAME=DeploymentQA
export GIT_AUTHOR_EMAIL=qa@example.invalid GIT_COMMITTER_EMAIL=qa@example.invalid
git init --quiet --bare "$scratch/engine.git"
git init --quiet --bare "$scratch/game.git"
git init --quiet -b main "$scratch/game"
git -C "$scratch/game" commit --quiet --allow-empty -m first
game_a=$(git -C "$scratch/game" rev-parse HEAD)
git -C "$scratch/game" remote add origin "$scratch/game.git"
git -C "$scratch/game" push --quiet origin main
git init --quiet -b main "$scratch/engine"
git -C "$scratch/engine" update-index --add --cacheinfo "160000,$game_a,src/games/fps"
git -C "$scratch/engine" commit --quiet -m first
engine_a=$(git -C "$scratch/engine" rev-parse HEAD)
git -C "$scratch/engine" remote add origin "$scratch/engine.git"
git -C "$scratch/engine" push --quiet origin main
export WASHOI_ROOT="$scratch/production"
mkdir -p "$WASHOI_ROOT/repos" "$WASHOI_ROOT/assets/data" "$WASHOI_ROOT/.deploy-state"
git clone --quiet -b main "$scratch/engine.git" "$WASHOI_ROOT/repos/shag"
git clone --quiet -b main "$scratch/game.git" "$WASHOI_ROOT/repos/shag/src/games/fps"
mkdir -p "$WASHOI_ROOT/repos/shag/public"
ln -s "$WASHOI_ROOT/assets/data" "$WASHOI_ROOT/repos/shag/public/data"
jq -n --arg engine "$engine_a" --arg game "$game_a" '{engine:$engine,game:$game}' >"$WASHOI_ROOT/release-pair.json"
washoi_pair_select
[[ $WASHOI_ENGINE == "$engine_a" && $WASHOI_GAME == "$game_a" ]]
git -C "$scratch/game" commit --quiet --allow-empty -m second
game_b=$(git -C "$scratch/game" rev-parse HEAD)
git -C "$scratch/game" push --quiet origin main
washoi_pair_select
[[ $WASHOI_GAME == "$game_a" ]] # A game-only push cannot mix untested revisions.
git -C "$scratch/engine" update-index --cacheinfo "160000,$game_b,src/games/fps"
git -C "$scratch/engine" commit --quiet -m second
engine_b=$(git -C "$scratch/engine" rev-parse HEAD)
git -C "$scratch/engine" push --quiet origin main
# Simulate occupied lobbies; publication must not depend on idle detection.
ss() { echo connected; }
pgrep() { echo 1234; }
washoi_prepare
[[ $WASHOI_ENGINE == "$engine_b" && $WASHOI_GAME == "$game_b" ]]
[[ $(git -C "$WASHOI_ROOT/repos/shag/src/games/fps" rev-parse HEAD) == "$game_b" ]]
washoi_media_check
git -C "$scratch/game" commit --quiet --allow-empty -m unpublished
unpublished=$(git -C "$scratch/game" rev-parse HEAD)
git -C "$scratch/engine" update-index --cacheinfo "160000,$unpublished,src/games/fps"
git -C "$scratch/engine" commit --quiet -m unpublished
git -C "$scratch/engine" push --quiet origin main
if washoi_pair_select; then echo 'ERROR: accepted unpublished game'; exit 1; fi
washoi_pair_read
[[ $WASHOI_ENGINE == "$engine_b" && $WASHOI_GAME == "$game_b" ]]
jq -n --arg engine "$engine_a" --arg game "$game_a" '{mode:"pinned",engine:$engine,game:$game}' >"$WASHOI_ROOT/release-pair.json"
washoi_prepare
[[ $(git -C "$WASHOI_ROOT/repos/shag" rev-parse HEAD) == "$engine_a" ]]
rm "$WASHOI_ROOT/repos/shag/public/data"
if washoi_prepare; then echo 'ERROR: accepted missing media link'; exit 1; fi
echo 'PASS: main pairing, game-only publication, occupied checkout, unpublished rejection, pinned rollback, media protection'
