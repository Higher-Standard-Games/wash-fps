#!/usr/bin/env bash
set -euo pipefail
ROOT=${WASHOI_ROOT:-/srv/washoi}
cd "$ROOT/repos/shag"
check=0
if [[ ${1:-} == --check ]]; then check=1; shift; fi
kind=${1:?Expected lobby or bot}; shift
case "$kind" in
  lobby) name=lobby-server ;;
  bot) name=bot-server ;;
  *) echo 'Expected lobby or bot' >&2; exit 1 ;;
esac
command=(/usr/bin/node)
if [[ -s dist-server/$name.mjs ]]; then
  command+=("dist-server/$name.mjs")
else
  source="src/games/fps/cli/$name.ts"
  [[ -f $source ]] || source="src/cli/$name.ts"
  [[ -s $source ]] || { echo "Missing $name entry" >&2; exit 1; }
  command+=(node_modules/vite-node/vite-node.mjs "$source")
fi
if (( check )); then printf '%s\n' "${command[@]}"; exit 0; fi
exec "${command[@]}" "$@"
