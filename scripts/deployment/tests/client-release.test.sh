#!/usr/bin/env bash
# client-release.sh against a fake GitHub API on disk (curl reads file://).
set -euo pipefail
source "${1:-$(dirname "$0")/../client-release.sh}"
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
api="$scratch/api"
mkdir -p "$api/repos/o/r/releases" "$scratch/assets"
printf 'token' >"$scratch/token"
release() { # release <tag> <asset names...>
  local tag="$1"; shift
  local assets="[]" n
  for n in "$@"; do
    printf '%s' "$n" >"$scratch/assets/$n"
    assets=$(jq -c --arg n "$n" --arg u "file://$scratch/assets/$n" --argjson s "${#n}" \
      '. + [{name:$n, url:$u, size:$s}]' <<<"$assets")
  done
  jq -n --arg t "$tag" --argjson a "$assets" '{tag_name:$t, published_at:"2026-11-03T00:00:00Z", assets:$a}' \
    >"$api/repos/o/r/releases/latest"
}
publish() { washoi_client_publish "file://$api" o/r "$scratch/token" "$scratch/client" https://washoi.net/client "$scratch/state"; }

# No token: skipped, nothing written.
washoi_client_publish "file://$api" o/r "$scratch/none" "$scratch/client" x "$scratch/state" | grep -q 'no token'
[[ ! -e "$scratch/client" ]]

release v1.2.0 washoi-1.2.0-linux-x86_64.tar.gz washoi-1.2.0-windows-x86_64.zip washoi-1.2.0-macos-aarch64.zip \
  washoi-1.2.0-windows-x86_64-setup.exe washoi-1.2.0-linux-x86_64-setup.exe \
  notes.txt washoi-1.1.0-linux-x86_64.tar.gz
publish
jq -e '.version == "1.2.0" and (.files | length) == 4' "$scratch/client/latest.json" >/dev/null
# The installer, under its platform, for the game's self-update.
jq -e '[.files[] | select(.platform == "windows-x86_64") | .name] | sort
  == ["washoi-1.2.0-windows-x86_64-setup.exe", "washoi-1.2.0-windows-x86_64.zip"]' "$scratch/client/latest.json" >/dev/null
jq -e '.files[] | select(.platform == "macos-aarch64")
  | .url == "https://washoi.net/client/1.2.0/washoi-1.2.0-macos-aarch64.zip"' "$scratch/client/latest.json" >/dev/null
[[ ! -e "$scratch/client/1.2.0/notes.txt" ]]
[[ "$(sha256sum <"$scratch/client/1.2.0/washoi-1.2.0-windows-x86_64.zip" | cut -d' ' -f1)" == \
   "$(jq -r '.files[] | select(.name == "washoi-1.2.0-windows-x86_64.zip") | .sha256' "$scratch/client/latest.json")" ]]

# The same tag again: nothing fetched.
rm "$scratch/assets/"*
publish | grep -q 'already published'

# A failed download keeps the last release served.
release v1.3.0 washoi-1.3.0-linux-x86_64.tar.gz
rm "$scratch/assets/washoi-1.3.0-linux-x86_64.tar.gz"
if publish; then echo "a failed fetch must fail"; exit 1; fi
jq -e '.version == "1.2.0"' "$scratch/client/latest.json" >/dev/null
[[ ! -e "$scratch/client/1.3.0" ]]

# A tag that is not a version publishes nothing.
release nightly washoi-nightly-linux-x86_64.tar.gz
if publish; then echo "a non-version tag must fail"; exit 1; fi

# Three newest versions are kept.
for v in 1.3.0 1.4.0 1.5.0; do
  release "v$v" "washoi-$v-linux-aarch64.tar.gz"
  publish >/dev/null
done
[[ "$(find "$scratch/client" -mindepth 1 -maxdepth 1 -type d ! -name '.*' | wc -l)" == 3 ]]
[[ ! -e "$scratch/client/1.2.0" ]]
jq -e '.version == "1.5.0" and .files[0].platform == "linux-aarch64"' "$scratch/client/latest.json" >/dev/null
echo "client-release: ok"
