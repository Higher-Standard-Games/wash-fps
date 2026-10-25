#!/usr/bin/env bash
#
# /srv/washoi/deploy.sh — publish a pinned engine/game pair and site surfaces.
#
# Runs as the unprivileged `washoi` user and only READS from GitHub (the repo
# deploy keys in /srv/washoi/.ssh are read-only). Publishing is static file
# replacement under /srv/washoi/releases/, which is the only tree Caddy reads.
# No root, no GitHub writes, no service restarts (static content needs no Caddy
# reload; Caddyfile changes are a separate, deliberate step).
#
# Usage:
#   deploy.sh [--force] [SURFACE...]
# Surfaces: site engine-docs fps-docs game studio  (default: all)
#
#   studio      higherstandardgames/dist -> releases/studio (higherstandardgames.com)
#   site        washoi-net/dist            -> releases/site     (washoi.net)
#   engine-docs shag dist-docs + docs/api  -> releases/docs     (shag.dev)
#   fps-docs    fps/dist-docs              -> releases/manual   (manual.washoi.net)
#   game        shag/dist (VITE_LOBBY_URL) -> releases/game     (eu.washoi.net)
#
# Idempotent: a surface rebuilds only when its commit changed (or --force).
# Never runs `git clean` (the ignored public/data symlink must survive, §12).
# Never touches assets/, server-data/, certs/ or env/.
#
set -euo pipefail

ROOT=/srv/washoi
REPOS="$ROOT/repos"
RELEASES="$ROOT/releases"
STATE="$ROOT/.deploy-state"
LOGDIR="$ROOT/logs"

# Be the app user even if invoked as root, so git/ssh find the right keys+HOME.
if [[ ${EUID} -eq 0 ]]; then
  exec sudo -u washoi env HOME="$ROOT" "$0" "$@"
fi

# HOME is /srv/washoi (the washoi user's home); git+ssh config live there.
export HOME="$ROOT"
cd "$ROOT"

# The lobby address is baked into the game client at build time.
VITE_LOBBY_URL_EU="wss://eu.washoi.net/lobby"

mkdir -p "$STATE" "$LOGDIR"

# Each run writes its own timestamped log, so there is no single growing file for
# logrotate to rotate; bound the directory by age instead. Runs before the log
# redirect so pruning is not itself written to the log.
find "$LOGDIR" -maxdepth 1 -name 'deploy-*.log' -type f -mtime +14 -delete 2>/dev/null || true

LOG="$LOGDIR/deploy-$(date -u +%Y%m%dT%H%M%SZ).log"
exec > >(tee -a "$LOG") 2>&1

log()  { printf '[%s] %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
die()  { log "ERROR: $*"; exit 1; }

command -v rsync >/dev/null || die "rsync not installed"

# ---- single-run lock -------------------------------------------------------
exec 9>"$STATE/deploy.lock"
if ! flock -n 9; then
  log "another deploy is already running; nothing to do"
  exit 0
fi

# ---- args ------------------------------------------------------------------
FORCE=0
TARGETS=()
for a in "$@"; do
  case "$a" in
    --force) FORCE=1 ;;
    site|engine-docs|fps-docs|game|studio|all) TARGETS+=("$a") ;;
    *) die "unknown argument: $a" ;;
  esac
done
[[ ${#TARGETS[@]} -eq 0 ]] && TARGETS=("all")
want() {
  local t
  for t in "${TARGETS[@]}"; do
    [[ "$t" == "all" || "$t" == "$1" ]] && return 0
  done
  return 1
}

DEPLOYED=0

# ---- helpers ---------------------------------------------------------------
prepare() { # prepare unrelated site repositories from main
  local d="$1"; shift
  log "fetch $d"
  git -C "$d" fetch --prune --quiet origin main
  git -C "$d" merge --ff-only --quiet origin/main

}

changed() { # changed <surface> <current-sha>  -> 0 yes, 1 no
  local f="$STATE/$1.sha"
  [[ $FORCE -eq 1 ]] && return 0
  [[ -f "$f" && "$(cat "$f")" == "$2" ]] && return 1
  return 0
}
mark() { printf '%s\n' "$2" > "$STATE/$1.sha"; log "recorded $1 @ ${2:0:12}"; }

ensure_deps() { # ensure_deps <repo-dir>  — npm ci only when the lockfile changed
  local d="$1" lock="$d/package-lock.json" key sf
  [[ -f "$lock" ]] || die "no package-lock.json in $d"
  key="$(sha1sum "$lock" | cut -d' ' -f1)"
  sf="$STATE/$(basename "$d").lock"
  if [[ -d "$d/node_modules" && -f "$sf" && "$(cat "$sf")" == "$key" ]]; then
    log "deps unchanged in $d — skipping npm ci"
  else
    log "npm ci in $d"
    ( cd "$d" && npm ci --no-audit --no-fund )
    printf '%s\n' "$key" > "$sf"
  fi
}

publish() { # publish <src-dir/> <dest-dir/> [rsync excludes...]
  local src="$1" dest="$2"; shift 2
  [[ -d "$src" ]] || die "build output missing: $src"
  log "publish $src -> $dest"
  mkdir -p "$dest"
  rsync -a --delete "$@" "$src" "$dest"
}

# ---- surfaces --------------------------------------------------------------
deploy_site() {
  local d="$REPOS/washoi-net"
  prepare "$d"
  local cur; cur="$(git -C "$d" rev-parse HEAD)"
  changed site "$cur" || { log "site unchanged"; return; }
  ensure_deps "$d"
  log "build site"
  ( cd "$d" && npm run typecheck && npm run build )
  publish "$d/dist/" "$RELEASES/site/"
  mark site "$cur"; DEPLOYED=1
}

# Engine main selects a matching engine/game pair, fetched independently.
source "$ROOT/workspace.sh"
prepare_shag() {
  local d="$REPOS/shag"
  local result=0
  washoi_prepare || result=$?
  [[ $result != 75 ]] || exit 0
  [[ $result == 0 ]] || die "workspace preparation failed"
  ensure_deps "$d"
}

deploy_engine_docs() {
  prepare_shag
  local d="$REPOS/shag" cur; cur="$(washoi_pair_id)"
  changed engine-docs "$cur" || { log "engine-docs unchanged"; return; }
  log "build engine docs (api + manual)"
  ( cd "$d" && npm run docs:api && npm run docs:build )
  publish "$d/dist-docs/" "$RELEASES/docs/"
  # The manual is its own root; typedoc output is a subpath of it.
  publish "$d/docs/api/" "$RELEASES/docs/api/"
  mark engine-docs "$cur"; DEPLOYED=1
}

deploy_fps_docs() {
  prepare_shag
  local d="$REPOS/shag"
  local cur; cur="$(washoi_pair_id)"
  changed fps-docs "$cur" || { log "fps-docs unchanged"; return; }
  log "build FPS game manual"
  washoi_game run docs:build
  publish "$d/src/games/fps/dist-docs/" "$RELEASES/manual/"
  mark fps-docs "$cur"; DEPLOYED=1
}

deploy_game() {
  prepare_shag
  local d="$REPOS/shag" cur; cur="$(washoi_pair_id)"
  changed game "$cur" || { log "game unchanged"; return; }
  log "build game client (VITE_LOBBY_URL=$VITE_LOBBY_URL_EU)"
  washoi_game run build:server
  VITE_LOBBY_URL="$VITE_LOBBY_URL_EU" washoi_game run build
  publish "$d/dist/" "$RELEASES/game/" \
    --exclude 'sourcemaps/' --exclude 'stats.html' --exclude 'data/'
  rsync -a --exclude demos/ --exclude washoi_textures.pk3 "$d/dist/data/" "$RELEASES/game/data/"
  mark game "$cur"; DEPLOYED=1
}

deploy_studio() {
  local d="$REPOS/higherstandardgames"
  prepare "$d"
  local cur; cur="$(git -C "$d" rev-parse HEAD)"
  changed studio "$cur" || { log "studio unchanged"; return; }
  ensure_deps "$d"
  log "build studio"
  ( cd "$d" && npm run build )
  [[ -s "$d/dist/index.html" ]] || die "studio build is missing index.html"
  publish "$d/dist/" "$RELEASES/studio/"
  mark studio "$cur"; DEPLOYED=1
}

# ---- run -------------------------------------------------------------------
log "deploy start: targets=${TARGETS[*]} force=$FORCE"

want site        && deploy_site
want engine-docs && deploy_engine_docs
want fps-docs    && deploy_fps_docs
want game        && deploy_game
want studio      && deploy_studio

if [[ $DEPLOYED -eq 1 ]]; then
  log "deploy done — published content updated (Caddy serves from disk; no reload needed)"
else
  log "deploy done — nothing changed"
fi
log "log: $LOG"
