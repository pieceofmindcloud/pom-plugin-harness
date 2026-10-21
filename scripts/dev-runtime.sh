#!/usr/bin/env bash
# Rebuild step of the POM's local development rebuild (`development.rebuild`
# in ui/manifest.json): the runtime archive build.rs embeds, written to
# $POM_PLUGIN_OUT_DIR. It packs the runtime scripts/fetch-runtime.sh staged in
# build/runtime-<platform> with this source's launcher, agents and setup
# scripts, so a change to them reaches the rebuild without downloading the
# runtime again. Run fetch-runtime.sh once, on this platform, first.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
out="${POM_PLUGIN_OUT_DIR:?dev-runtime: POM_PLUGIN_OUT_DIR is not set}"
platform="${POM_PLUGIN_PLATFORM:?dev-runtime: POM_PLUGIN_PLATFORM is not set}"
stage="$root/build/runtime-$platform"
[[ -d "$stage" ]] || {
  echo "dev-runtime: $stage is missing; run scripts/fetch-runtime.sh --platform $platform once" >&2
  exit 2
}

scripts=(launcher.mjs agents.mjs agent-setup.mjs browser-skill.md)
excludes=()
for name in "${scripts[@]}" agent-shim.mjs agents.json runtime.json; do excludes+=("--exclude=./$name"); done
archive="$out/runtime-$platform.tar.gz"
mkdir -p "$out"
metadata="$(mktemp -d "$out/runtime-metadata.XXXXXX")"
trap 'rm -rf "$metadata" "$archive.tmp.tar" "$archive.tmp"' EXIT
# An older staged runtime may still pin removed agents; never ship those pins again.
jq '{npm: (.npm | with_entries(select(.key == "opencode-ai" or .key == "chrome-devtools-axi")))}' \
  "$stage/agents.json" > "$metadata/agents.json"
jq --slurpfile agents "$metadata/agents.json" '.agents = $agents[0]' \
  "$stage/runtime.json" > "$metadata/runtime.json"
# --exclude also applies to later operands on both GNU tar and bsdtar.
# Append the updated files separately, then compress the complete archive.
COPYFILE_DISABLE=1 tar -cf "$archive.tmp.tar" "${excludes[@]}" -C "$stage" .
COPYFILE_DISABLE=1 tar -rf "$archive.tmp.tar" -C "$root/runtime" "${scripts[@]}" -C "$metadata" agents.json runtime.json
gzip -c "$archive.tmp.tar" > "$archive.tmp"
mv "$archive.tmp" "$archive"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$archive" | cut -d' ' -f1 > "$archive.sha256"
else
  shasum -a 256 "$archive" | cut -d' ' -f1 > "$archive.sha256"
fi
echo "dev-runtime: $archive" >&2
