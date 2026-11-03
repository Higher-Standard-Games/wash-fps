#!/usr/bin/env bash
#
# /srv/washoi/client-release.sh — sourced by deploy.sh (EU) for the `client`
# surface: the native game's newest published release, served from
# washoi.net/client/ for players to download and for the game's own update
# check.
#
# Reads only: the GitHub API with a read-only token (Contents: read on the
# client repository), from a file under env/ that this script never writes.
# Draft releases are invisible to `releases/latest`, so publishing a draft
# on GitHub is what ships it.
#
# Layout under <dest>:
#   <version>/washoi-<version>-<os>-<arch>.<zip|tar.gz>
#   latest.json   {"version","tag","publishedAt","files":[{platform,name,url,size,sha256}]}
# The newest three versions are kept; latest.json is replaced last, by rename.

# washoi_client_publish <api-base> <owner/repo> <token-file> <dest-dir> <public-url> <state-file>
#   0 published or unchanged; 1 failed (the previous release stays served).
washoi_client_publish() {
  local api="$1" repo="$2" token_file="$3" dest="$4" public="$5" state="$6"
  local token release tag version stage assets name platform url size sha files
  if [[ ! -s "$token_file" ]]; then
    echo "client: no token at $token_file; skipped"
    return 0
  fi
  token="$(<"$token_file")"
  release="$(curl -fsSL --max-time 30 \
    -H "Authorization: Bearer $token" -H "Accept: application/vnd.github+json" \
    "$api/repos/$repo/releases/latest")" || { echo "client: no published release"; return 0; }
  tag="$(jq -r '.tag_name // empty' <<<"$release")"
  version="${tag#v}"
  if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.]+)?$ ]]; then
    echo "client: release tag '$tag' is not a version; skipped"
    return 1
  fi
  if [[ -f "$state" && "$(<"$state")" == "$tag" && -s "$dest/latest.json" ]]; then
    echo "client: $tag already published"
    return 0
  fi
  mkdir -p "$dest"
  stage="$dest/.$version.part"
  rm -rf "$stage"
  mkdir -p "$stage"
  files="[]"
  # Only the game's own packages, by the names tools/package.sh gives them.
  assets="$(jq -c --arg v "$version" '.assets[]
    | select(.name | test("^washoi-" + ($v | gsub("\\."; "\\.")) + "-(linux|macos|windows)-(x86_64|aarch64)\\.(zip|tar\\.gz)$"))
    | {name, url, size}' <<<"$release")"
  if [[ -z "$assets" ]]; then
    echo "client: $tag has no game packages"
    rm -rf "$stage"
    return 1
  fi
  while IFS= read -r asset; do
    name="$(jq -r .name <<<"$asset")"
    url="$(jq -r .url <<<"$asset")"
    size="$(jq -r .size <<<"$asset")"
    echo "client: fetch $name"
    if ! curl -fsSL --max-time 900 \
      -H "Authorization: Bearer $token" -H "Accept: application/octet-stream" \
      -o "$stage/$name" "$url"; then
      echo "client: $name could not be fetched"
      rm -rf "$stage"
      return 1
    fi
    if [[ "$(stat -c %s "$stage/$name")" != "$size" ]]; then
      echo "client: $name is not $size bytes"
      rm -rf "$stage"
      return 1
    fi
    sha="$(sha256sum "$stage/$name" | cut -d' ' -f1)"
    platform="$(sed -E 's/^.*-((linux|macos|windows)-(x86_64|aarch64))\.(zip|tar\.gz)$/\1/' <<<"$name")"
    files="$(jq -c --arg p "$platform" --arg n "$name" --arg u "$public/$version/$name" \
      --argjson s "$size" --arg h "$sha" '. + [{platform:$p, name:$n, url:$u, size:$s, sha256:$h}]' <<<"$files")"
  done <<<"$assets"
  rm -rf "${dest:?}/$version"
  mv "$stage" "$dest/$version"
  jq -n --arg v "$version" --arg t "$tag" --arg at "$(jq -r '.published_at // ""' <<<"$release")" \
    --argjson f "$files" '{version:$v, tag:$t, publishedAt:$at, files:$f}' >"$dest/.latest.json.part"
  mv "$dest/.latest.json.part" "$dest/latest.json"
  printf '%s\n' "$tag" >"$state"
  # Keep the three newest versions; a player mid-download keeps their file.
  find "$dest" -mindepth 1 -maxdepth 1 -type d ! -name '.*' -printf '%f\n' \
    | sort -rV | tail -n +4 \
    | while IFS= read -r old; do rm -rf "${dest:?}/$old"; done
  echo "client: published $tag ($(jq length <<<"$files") packages)"
}
