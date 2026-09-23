#!/usr/bin/env bash
# Assembles the runtime the plugin embeds, entirely from official releases:
# a portable Node.js, the herdr binary from its GitHub release, the prebuilt
# `@earendil-works/pi-coding-agent` npm release, node-pty and ws, plus our
# launcher. Nothing is compiled; native npm dependencies resolve for the
# platform this script runs on, so run it on the target platform.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
platform=""
pi_version="${PI_VERSION:-latest}"
herdr_version="${HERDR_VERSION:-latest}"
node_version="${PI_NODE_VERSION:-24.9.0}"
# node-pty 1.2 ships prebuilt addons for Linux, macOS and Windows.
node_pty_version="1.2.0-beta.15"
ws_version="8.21.3"
output="${root}/build"

usage() {
  printf '%s\n' \
    'Usage: scripts/fetch-runtime.sh --platform <linux-x86_64|macos-aarch64|windows-x86_64> [options]' \
    '  --pi-version <tag|version>     npm dist-tag or version of @earendil-works/pi-coding-agent (default: latest)' \
    '  --herdr-version <tag>          herdr GitHub release tag, for example v0.9.1 (default: latest)' \
    '  --node-version <version>       portable Node.js version (default: 24.9.0)' \
    '  --output <dir>                 build directory (default: build)'
}

die() {
  printf 'fetch-runtime: %s\n' "$1" >&2
  exit 2
}

sha256() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'; else sha256sum "$1" | awk '{print $1}'; fi
}

while (($# > 0)); do
  case "$1" in
    --platform) (($# >= 2)) || die '--platform requires a value'; platform="$2"; shift 2 ;;
    --pi-version) (($# >= 2)) || die '--pi-version requires a value'; pi_version="$2"; shift 2 ;;
    --herdr-version) (($# >= 2)) || die '--herdr-version requires a value'; herdr_version="$2"; shift 2 ;;
    --node-version) (($# >= 2)) || die '--node-version requires a value'; node_version="$2"; shift 2 ;;
    --output) (($# >= 2)) || die '--output requires a value'; output="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

[[ -n "$platform" ]] || die '--platform is required'
case "$platform" in
  linux-x86_64)
    node_dist="node-v${node_version}-linux-x64"; node_archive="${node_dist}.tar.xz"
    herdr_asset="herdr-linux-x86_64"; keep_pty="linux-x64" ;;
  macos-aarch64)
    node_dist="node-v${node_version}-darwin-arm64"; node_archive="${node_dist}.tar.gz"
    herdr_asset="herdr-macos-aarch64"; keep_pty="darwin-arm64" ;;
  windows-x86_64)
    node_dist="node-v${node_version}-win-x64"; node_archive="${node_dist}.zip"
    herdr_asset="herdr-windows-x86_64.zip"; keep_pty="win32-x64" ;;
  *) die "unsupported platform: $platform" ;;
esac
for tool in curl npm tar jq; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is required"
done

pi_resolved="$(npm view "@earendil-works/pi-coding-agent@${pi_version}" version --json | tr -d '"[:space:]')"
[[ "$pi_resolved" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]] || die "could not resolve @earendil-works/pi-coding-agent@${pi_version}"

api="https://api.github.com/repos/herdrdev/herdr/releases"
if [[ "$herdr_version" == latest ]]; then release_url="${api}/latest"; else release_url="${api}/tags/${herdr_version}"; fi
release="$(curl -fsSL -H 'Accept: application/vnd.github+json' ${GITHUB_TOKEN:+-H "Authorization: Bearer ${GITHUB_TOKEN}"} "$release_url")"
herdr_resolved="$(jq -r '.tag_name' <<<"$release")"
herdr_url="$(jq -r --arg name "$herdr_asset" '.assets[] | select(.name == $name) | .browser_download_url' <<<"$release")"
herdr_digest="$(jq -r --arg name "$herdr_asset" '.assets[] | select(.name == $name) | .digest // empty' <<<"$release")"
[[ -n "$herdr_url" && "$herdr_digest" == sha256:* ]] || die "herdr ${herdr_resolved} has no ${herdr_asset} with a SHA-256 digest"

stage="${output}/runtime-${platform}"
downloads="${output}/downloads"
rm -rf "$stage"
mkdir -p "$stage/app" "$stage/bin" "$downloads"

# Portable Node.js, verified against the release's SHASUMS256.
node_url="https://nodejs.org/dist/v${node_version}"
[[ -f "${downloads}/${node_archive}" ]] || curl -fsSL -o "${downloads}/${node_archive}" "${node_url}/${node_archive}"
expected="$(curl -fsSL "${node_url}/SHASUMS256.txt" | awk -v name="$node_archive" '$2 == name {print $1}')"
[[ -n "$expected" && "$(sha256 "${downloads}/${node_archive}")" == "$expected" ]] || die "Node.js archive checksum mismatch for ${node_archive}"
unpack="${output}/unpack"
rm -rf "$unpack" && mkdir -p "$unpack"
case "$node_archive" in
  *.zip) (cd "$unpack" && unzip -q "${downloads}/${node_archive}") ;;
  *) tar -xf "${downloads}/${node_archive}" -C "$unpack" ;;
esac
if [[ "$platform" == windows-x86_64 ]]; then
  cp "${unpack}/${node_dist}/node.exe" "$stage/bin/node.exe"
else
  cp "${unpack}/${node_dist}/bin/node" "$stage/bin/node"
fi
cp "${unpack}/${node_dist}/LICENSE" "$stage/bin/NODE_LICENSE"
rm -rf "$unpack"

# herdr, verified against the digest GitHub publishes for the release asset.
herdr_file="${downloads}/${herdr_resolved}-${herdr_asset}"
[[ -f "$herdr_file" ]] || curl -fsSL -o "$herdr_file" "$herdr_url"
[[ "sha256:$(sha256 "$herdr_file")" == "$herdr_digest" ]] || die "herdr ${herdr_resolved} checksum mismatch"
if [[ "$herdr_asset" == *.zip ]]; then
  mkdir -p "$unpack" && (cd "$unpack" && unzip -q "$herdr_file")
  cp "$(find "$unpack" -name herdr.exe | head -1)" "$stage/bin/herdr.exe"
  rm -rf "$unpack"
else
  cp "$herdr_file" "$stage/bin/herdr"
  chmod +x "$stage/bin/herdr"
fi

# pi and the terminal bridge, production dependencies only.
cat > "$stage/app/package.json" <<JSON
{
  "name": "pom-pi-runtime",
  "private": true,
  "dependencies": {
    "@earendil-works/pi-coding-agent": "${pi_resolved}",
    "node-pty": "${node_pty_version}",
    "ws": "${ws_version}"
  }
}
JSON
(
  cd "$stage/app"
  npm install --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error >&2
)

# Drop prebuilt binaries and type declarations the target never loads.
if [[ -d "$stage/app/node_modules/node-pty/prebuilds" ]]; then
  find "$stage/app/node_modules/node-pty/prebuilds" -mindepth 1 -maxdepth 1 -type d ! -name "$keep_pty" -exec rm -rf {} +
fi
find "$stage/app/node_modules" -name '*.d.ts' -type f -delete

cp "$root/runtime/launcher.mjs" "$stage/launcher.mjs"
printf '{\n  "pi_version": "%s",\n  "herdr_version": "%s",\n  "node_version": "%s",\n  "platform": "%s"\n}\n' \
  "$pi_resolved" "$herdr_resolved" "$node_version" "$platform" > "$stage/runtime.json"

archive="${output}/runtime-${platform}.tar.gz"
tar -czf "$archive" -C "$stage" .
size="$(wc -c < "$archive" | tr -d '[:space:]')"
checksum="$(sha256 "$archive")"
printf '%s\n' "$checksum" > "${archive}.sha256"
printf 'archive=%s\nsha256=%s\npi_version=%s\nherdr_version=%s\nnode_version=%s\nsize=%s\n' \
  "$archive" "$checksum" "$pi_resolved" "$herdr_resolved" "$node_version" "$size"
