#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
platform=""
version=""
output="${root}/dist-release"
pi_version="${PI_VERSION:-latest}"
herdr_version="${HERDR_VERSION:-latest}"

usage() {
  printf '%s\n' \
    'Usage: scripts/package.sh --platform <linux-x86_64|macos-aarch64|windows-x86_64> --version <semver> [options]' \
    '  --output <dir>        package directory (default: dist-release)' \
    '  --pi-version <tag>    @earendil-works/pi-coding-agent npm dist-tag or version (default: latest)' \
    '  --herdr-version <tag> herdr GitHub release tag (default: latest)'
}

die() {
  printf 'package: %s\n' "$1" >&2
  exit 2
}

while (($# > 0)); do
  case "$1" in
    --platform) (($# >= 2)) || die '--platform requires a value'; platform="$2"; shift 2 ;;
    --version) (($# >= 2)) || die '--version requires a value'; version="$2"; shift 2 ;;
    --output) (($# >= 2)) || die '--output requires a value'; output="$2"; shift 2 ;;
    --pi-version) (($# >= 2)) || die '--pi-version requires a value'; pi_version="$2"; shift 2 ;;
    --herdr-version) (($# >= 2)) || die '--herdr-version requires a value'; herdr_version="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

[[ -n "$platform" ]] || die '--platform is required'
[[ -n "$version" ]] || die '--version is required'
command -v jq >/dev/null 2>&1 || die 'jq is required'

case "$platform" in
  linux-x86_64) os="linux"; arch="x86_64" ;;
  macos-aarch64) os="macos"; arch="aarch64" ;;
  windows-x86_64) os="windows"; arch="x86_64" ;;
  *) die "unsupported platform: $platform" ;;
esac

plugin_code="$(jq -er '.plugin_code | strings' "$root/ui/manifest.json")" || die 'manifest has no plugin code'
[[ "$plugin_code" =~ ^[a-z][a-z0-9_]{1,63}$ ]] || die 'manifest plugin code is invalid'

build_output="$("$root/scripts/build.sh" --platform "$platform" --output "$output" --pi-version "$pi_version" --herdr-version "$herdr_version")"
artifact="$(printf '%s\n' "$build_output" | sed -n 's/^artifact=//p')"
sha256="$(printf '%s\n' "$build_output" | sed -n 's/^sha256=//p')"
size="$(printf '%s\n' "$build_output" | sed -n 's/^size=//p')"
target="$(printf '%s\n' "$build_output" | sed -n 's/^target=//p')"
pi_resolved="$(printf '%s\n' "$build_output" | sed -n 's/^pi_version=//p')"
herdr_resolved="$(printf '%s\n' "$build_output" | sed -n 's/^herdr_version=//p')"

metadata="${output}/pom-plugin-harness-${platform}.metadata.json"
public_manifest="${output}/pom-plugin-${platform}.json"
cat > "$metadata" <<JSON
{
  "plugin_code": "${plugin_code}",
  "version": "${version}",
  "platform": "${platform}",
  "target": "${target}",
  "plugin_abi": 1,
  "sha256": "${sha256}",
  "size": ${size},
  "artifact": "$(basename "$artifact")",
  "pi_version": "${pi_resolved}",
  "herdr_version": "${herdr_resolved}"
}
JSON
# POM's GitHub installer reads pom-plugin-<os>-<arch>.json from the release.
jq -n \
  --slurpfile contract "$root/release/manifest.json" \
  --arg release_id "v${version}" --arg version "$version" \
  --arg os "$os" --arg arch "$arch" --arg asset "$(basename "$artifact")" \
  --arg sha256 "$sha256" --argjson size "$size" \
  '($contract[0]) + {release_id:$release_id, version:$version, os:$os, arch:$arch, asset:$asset, sha256:$sha256, size:$size}' \
  > "$public_manifest" || die 'could not generate the GitHub release manifest'
[[ "$(jq -r .plugin_code "$public_manifest")" == "$plugin_code" ]] || die 'release/manifest.json plugin code does not match the manifest'

printf 'artifact=%s\nmetadata=%s\npublic_manifest=%s\nsha256=%s\nsize=%s\nversion=%s\nplatform=%s\npi_version=%s\nherdr_version=%s\n' \
  "$artifact" "$metadata" "$public_manifest" "$sha256" "$size" "$version" "$platform" "$pi_resolved" "$herdr_resolved"
