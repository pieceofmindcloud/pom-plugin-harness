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

scripts=(launcher.mjs agents.mjs agent-shim.mjs agent-setup.mjs)
excludes=()
for name in "${scripts[@]}"; do excludes+=("--exclude=./$name"); done
archive="$out/runtime-$platform.tar.gz"
mkdir -p "$out"
COPYFILE_DISABLE=1 tar -czf "$archive.tmp" "${excludes[@]}" -C "$stage" . -C "$root/runtime" "${scripts[@]}"
mv "$archive.tmp" "$archive"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$archive" | cut -d' ' -f1 > "$archive.sha256"
else
  shasum -a 256 "$archive" | cut -d' ' -f1 > "$archive.sha256"
fi
echo "dev-runtime: $archive" >&2
