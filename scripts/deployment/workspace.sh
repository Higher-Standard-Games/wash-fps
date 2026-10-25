#!/usr/bin/env bash
# Sourced by the regional deploy/validation scripts.
WASHOI_ROOT=${WASHOI_ROOT:-/srv/washoi}

washoi_media_check() {
  local d="$WASHOI_ROOT/repos/shag"
  [[ -L "$d/public/data" && $(readlink -f "$d/public/data") == "$WASHOI_ROOT/assets/data" && -d "$WASHOI_ROOT/assets/data" ]] || {
    echo 'ERROR: persistent public/data link missing or changed' >&2; return 1;
  }
}

washoi_pair_read() {
  local config="$WASHOI_ROOT/release-pair.json"
  WASHOI_ENGINE=$(jq -er '.engine | select(test("^[0-9a-f]{40}$"))' "$config") || return 1
  WASHOI_GAME=$(jq -er '.game | select(test("^[0-9a-f]{40}$"))' "$config") || return 1
}

washoi_pair_id() {
  printf '%s\n%s\n' "$WASHOI_ENGINE" "$WASHOI_GAME" | sha1sum | cut -d' ' -f1
}

# Engine main selects its tested game gitlink, never an unrelated game main tip.
washoi_pair_select() {
  local d="$WASHOI_ROOT/repos/shag" config="$WASHOI_ROOT/release-pair.json" mode engine game tmp
  mode=$(jq -er '.mode // "main"' "$config") || return 1
  case "$mode" in
    pinned) washoi_pair_read; return $? ;;
    main) ;;
    *) echo "ERROR: unknown release mode: $mode" >&2; return 1 ;;
  esac
  git -C "$d" fetch --quiet origin refs/heads/main:refs/remotes/origin/main || return 1
  engine=$(git -C "$d" rev-parse refs/remotes/origin/main) || return 1
  game=$(git -C "$d" ls-tree "$engine" -- src/games/fps | awk '$1 == "160000" && $2 == "commit" {print $3}') || return 1
  [[ $engine =~ ^[0-9a-f]{40}$ && $game =~ ^[0-9a-f]{40}$ ]] || {
    echo 'ERROR: engine main has no valid game revision' >&2; return 1;
  }
  git -C "$d/src/games/fps" fetch --quiet origin refs/heads/main:refs/remotes/origin/main || return 1
  git -C "$d/src/games/fps" merge-base --is-ancestor "$game" refs/remotes/origin/main || {
    echo 'ERROR: selected game revision is not published on game main' >&2; return 1;
  }
  tmp=$(mktemp "$config.XXXXXX") || return 1
  if ! jq -n --arg engine "$engine" --arg game "$game" '{mode:"main",engine:$engine,game:$game}' >"$tmp"; then
    rm -f "$tmp"; return 1
  fi
  mv "$tmp" "$config" || return 1
  washoi_pair_read
}

washoi_prepare() {
  local d="$WASHOI_ROOT/repos/shag" mode=${1:-fetch}
  washoi_media_check || return 1
  if [[ $mode == --no-fetch ]]; then washoi_pair_read || return 1
  else washoi_pair_select || return 1; fi
  # Fetch each repository directly. Never run submodule update or git clean.
  if [[ $mode != --no-fetch ]]; then
    git -C "$d" fetch --quiet origin "$WASHOI_ENGINE" || return 1
    git -C "$d/src/games/fps" fetch --quiet origin "$WASHOI_GAME" || return 1
  fi
  # Checkouts fail on conflicting local edits; nothing is reset or removed.
  if [[ $(git -C "$d" rev-parse HEAD) != "$WASHOI_ENGINE" ]]; then git -c submodule.recurse=false -C "$d" checkout --quiet --detach "$WASHOI_ENGINE" || return 1; fi
  if [[ $(git -C "$d/src/games/fps" rev-parse HEAD) != "$WASHOI_GAME" ]]; then git -C "$d/src/games/fps" checkout --quiet --detach "$WASHOI_GAME" || return 1; fi
  washoi_media_check || return 1
  local state="$WASHOI_ROOT/.deploy-state/checkout-pair.json"
  jq -n --arg engine "$WASHOI_ENGINE" --arg game "$WASHOI_GAME" '{engine:$engine,game:$game}' >"$state.tmp"
  mv "$state.tmp" "$state"
}

washoi_game() {
  local d="$WASHOI_ROOT/repos/shag" script
  [[ ${1:-} == run ]] || { echo 'Expected run <script>' >&2; return 1; }
  shift; script=$1; shift
  if [[ -f "$d/src/games/fps/package.json" ]]; then
    (cd "$d" && npm --prefix "$d/src/games/fps" run "$script" "$@")
  else
    # Existing alpha.2 remains deployable until the new pair is published.
    [[ $script != docs:build ]] || script=docs:fps:build
    (cd "$d" && SHAG_APP="$d/src/games/fps" npm run "$script" "$@")
  fi
}
