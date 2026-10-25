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
echo keep >"$WASHOI_ROOT/releases/game/data/demos/existing.demo"
echo "$sha" >"$WASHOI_ROOT/.deploy-state/pending.sha"
bash "$scripts/activate-us.sh"
[[ ! -e "$WASHOI_ROOT/.deploy-state/pending.sha" && ! -e "$WASHOI_ROOT/.maintenance" ]]
[[ $(cat "$WASHOI_ROOT/.deploy-state/game.sha") == "$sha" ]]
[[ $(cat "$WASHOI_ROOT/releases/game/data/demos/existing.demo") == keep ]]
bash "$scripts/activate-eu.sh"
[[ $(cat "$WASHOI_ROOT/.deploy-state/backend.sha") == "$sha" ]]
[[ $(grep -c '^restart ' "$WASHOI_ROOT/systemctl.log") == 2 ]]
bash "$scripts/activate-eu.sh"
[[ $(grep -c '^restart ' "$WASHOI_ROOT/systemctl.log") == 2 ]]
echo 'PASS: occupied activation, backend restarts, idempotence, maintenance cleanup and existing demo preservation'
