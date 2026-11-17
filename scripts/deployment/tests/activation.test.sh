#!/usr/bin/env bash
set -euo pipefail
scripts=${1:-$(dirname "$0")/..}
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
export WASHOI_ROOT="$scratch/production"
mkdir -p "$scratch/bin" "$WASHOI_ROOT/.deploy-state" "$WASHOI_ROOT/releases/game/data/demos" "$WASHOI_ROOT/repos/shag/dist-server"
cat >"$scratch/bin/systemctl" <<'MOCK'
#!/usr/bin/env bash
echo "$*" >>"$WASHOI_ROOT/systemctl.log"
[[ $1 == is-enabled && -n ${WASHOI_BOTS_DISABLED:-} ]] && exit 1
exit 0
MOCK
cat >"$scratch/bin/sudo" <<'MOCK'
#!/usr/bin/env bash
[[ $1 == -u && $2 == washoi ]]; shift 2; exec "$@"
MOCK
cat >"$scratch/bin/ss" <<'MOCK'
#!/usr/bin/env bash
echo connected
MOCK
cat >"$scratch/bin/pgrep" <<'MOCK'
#!/usr/bin/env bash
echo 1234
MOCK
chmod +x "$scratch/bin/"*
export PATH="$scratch/bin:$PATH"
sha=1234567890123456789012345678901234567890
stage="$WASHOI_ROOT/.pending/$sha"
mkdir -p "$stage/client/data" "$stage/server"
echo client >"$stage/client/index.html"
echo server >"$stage/server/lobby-server.mjs"
echo bot >"$stage/server/bot-server.mjs"
echo runner >"$stage/server/bot-runner.mjs"
echo keep >"$WASHOI_ROOT/releases/game/data/demos/existing.demo"
echo "$sha" >"$WASHOI_ROOT/.deploy-state/pending.sha"
for old in oldest previous incomplete; do mkdir -p "$WASHOI_ROOT/.pending/$old/client"; done
echo '{}' >"$WASHOI_ROOT/.pending/oldest/revisions.json"
touch -d '2 days ago' "$WASHOI_ROOT/.pending/oldest/revisions.json"
echo '{}' >"$WASHOI_ROOT/.pending/previous/revisions.json"
touch -d '1 day ago' "$WASHOI_ROOT/.pending/previous/revisions.json"
bash "$scripts/activate-us.sh"
[[ -d $stage && -d $WASHOI_ROOT/.pending/previous ]]
[[ ! -e $WASHOI_ROOT/.pending/oldest && ! -e $WASHOI_ROOT/.pending/incomplete ]]
[[ ! -e "$WASHOI_ROOT/.deploy-state/pending.sha" && ! -e "$WASHOI_ROOT/.maintenance" ]]
[[ $(cat "$WASHOI_ROOT/.deploy-state/game.sha") == "$sha" ]]
[[ $(cat "$WASHOI_ROOT/releases/game/data/demos/existing.demo") == keep ]]
bash "$scripts/activate-eu.sh"
[[ $(cat "$WASHOI_ROOT/.deploy-state/backend.sha") == "$sha" ]]
[[ $(grep -c '^restart ' "$WASHOI_ROOT/systemctl.log") == 2 ]]
bash "$scripts/activate-eu.sh"
[[ $(grep -c '^restart ' "$WASHOI_ROOT/systemctl.log") == 2 ]]
grep -qx 'restart washoi-lobby washoi-bots' "$WASHOI_ROOT/systemctl.log"
rm "$WASHOI_ROOT/.deploy-state/backend.sha"
WASHOI_BOTS_DISABLED=1 bash "$scripts/activate-eu.sh"
[[ $(tail -n 2 "$WASHOI_ROOT/systemctl.log" | head -n 1) == 'restart washoi-lobby' ]]
rm "$WASHOI_ROOT/.deploy-state/backend.sha" "$WASHOI_ROOT/repos/shag/dist-server/bot-runner.mjs"
if WASHOI_BOTS_DISABLED=1 bash "$scripts/activate-eu.sh" 2>/dev/null; then echo 'FAIL: activated a lobby without its match runner'; exit 1; fi
# US: a stage without the match runner is refused before anything is published
sha2=abcdefabcdefabcdefabcdefabcdefabcdefabcd
stage2="$WASHOI_ROOT/.pending/$sha2"
mkdir -p "$stage2/client" "$stage2/server"
echo client2 >"$stage2/client/index.html"
echo server2 >"$stage2/server/lobby-server.mjs"
echo "$sha2" >"$WASHOI_ROOT/.deploy-state/pending.sha"
if WASHOI_BOTS_DISABLED=1 bash "$scripts/activate-us.sh" 2>/dev/null; then echo 'FAIL: US activated a stage without its match runner'; exit 1; fi
[[ $(cat "$WASHOI_ROOT/repos/shag/dist-server/lobby-server.mjs") == server ]]
[[ $(cat "$WASHOI_ROOT/releases/game/index.html") == client ]]
[[ $(cat "$WASHOI_ROOT/.deploy-state/pending.sha") == "$sha2" ]]
echo 'PASS: occupied activation, US stage pruning, backend restarts (with and without washoi-bots), a stage without its runner refused before publishing, idempotence, maintenance cleanup and existing demo preservation'
