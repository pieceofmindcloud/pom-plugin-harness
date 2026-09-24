#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
platform=""
output="${root}/dist-release"
profile="release"
pi_version="${PI_VERSION:-latest}"
herdr_version="${HERDR_VERSION:-latest}"

usage() {
  printf '%s\n' \
    'Usage: scripts/build.sh --platform <linux-x86_64|macos-aarch64|windows-x86_64> [options]' \
    '  --output <dir>        artifact directory (default: dist-release)' \
    '  --pi-version <tag>    @earendil-works/pi-coding-agent npm dist-tag or version (default: latest)' \
    '  --herdr-version <tag> herdr GitHub release tag (default: latest)' \
    '  --debug               build the debug profile'
}

die() {
  printf 'build: %s\n' "$1" >&2
  exit 2
}

while (($# > 0)); do
  case "$1" in
    --platform) (($# >= 2)) || die '--platform requires a value'; platform="$2"; shift 2 ;;
    --output) (($# >= 2)) || die '--output requires a value'; output="$2"; shift 2 ;;
    --pi-version) (($# >= 2)) || die '--pi-version requires a value'; pi_version="$2"; shift 2 ;;
    --herdr-version) (($# >= 2)) || die '--herdr-version requires a value'; herdr_version="$2"; shift 2 ;;
    --debug) profile="debug"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

[[ -n "$platform" ]] || die '--platform is required'
case "$platform" in
  linux-x86_64) target="x86_64-unknown-linux-gnu"; extension="so" ;;
  macos-aarch64) target="aarch64-apple-darwin"; extension="dylib" ;;
  windows-x86_64) target="x86_64-pc-windows-msvc"; extension="dll" ;;
  *) die "unsupported platform: $platform" ;;
esac

if [[ "$profile" == release ]]; then
  cargo_args=(build --locked --release --target "$target")
  artifact_dir="${root}/target/${target}/release"
else
  cargo_args=(build --locked --target "$target")
  artifact_dir="${root}/target/${target}/debug"
fi

if [[ "$extension" == dll ]]; then
  artifact="${artifact_dir}/pom_plugin_harness.dll"
else
  artifact="${artifact_dir}/libpom_plugin_harness.${extension}"
fi

"$root/scripts/build-ui.sh"
runtime_output="$("$root/scripts/fetch-runtime.sh" --platform "$platform" --pi-version "$pi_version" --herdr-version "$herdr_version")"
runtime_archive="$(printf '%s\n' "$runtime_output" | sed -n 's/^archive=//p')"
pi_resolved="$(printf '%s\n' "$runtime_output" | sed -n 's/^pi_version=//p')"
herdr_resolved="$(printf '%s\n' "$runtime_output" | sed -n 's/^herdr_version=//p')"
[[ -f "$runtime_archive" ]] || die 'harness runtime archive was not produced'
(
  cd "$root"
  HARNESS_RUNTIME_ARCHIVE="$runtime_archive" cargo "${cargo_args[@]}"
)
[[ -f "$artifact" ]] || die "artifact not found: $artifact"

mkdir -p "$output"
destination="${output}/pom-plugin-harness-${platform}.${extension}"
cp "$artifact" "$destination"
if command -v shasum >/dev/null 2>&1; then
  sha256="$(shasum -a 256 "$destination" | awk '{print $1}')"
else
  sha256="$(sha256sum "$destination" | awk '{print $1}')"
fi
size="$(wc -c < "$destination" | tr -d '[:space:]')"

printf 'artifact=%s\nsha256=%s\nsize=%s\nplatform=%s\ntarget=%s\npi_version=%s\nherdr_version=%s\n' \
  "$destination" "$sha256" "$size" "$platform" "$target" "$pi_resolved" "$herdr_resolved"
