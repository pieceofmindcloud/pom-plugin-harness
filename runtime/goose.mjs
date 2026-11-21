/**
 * Goose in its own herdr tab, only while the Goose plugin (`goose`) is
 * installed on this machine. The Rust side writes `installed-plugins.json`
 * from the POM's `GET /api/plugin-host/plugins` and rewrites it on each
 * `plugin.*` event, so the order in which the two plugins were installed does
 * not matter.
 *
 * Harness keeps its own copy of the Goose CLI: plugins are a process boundary
 * and never share files. The release is pinned below with the SHA-256 digest
 * GitHub publishes for each asset (the same pin as `pom-plugin-goose`).
 * Goose runs with a private root (`GOOSE_PATH_ROOT`) whose
 * `config/custom_providers/pom.json` points at the node's `/v1`; the key comes
 * from `$POM_API_KEY` in the pane environment, never from a file.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const GOOSE_VERSION = "1.57.0";

const ASSETS = {
  "linux-x64": ["goose-x86_64-unknown-linux-gnu.tar.gz", "10eb96cb6a159b6e1d38eeedbef6ab64cd28168aad91948f1fa5c34eefdf98e3"],
  "linux-arm64": ["goose-aarch64-unknown-linux-gnu.tar.gz", "c32605acfd560aeb2adbf17ec359cc0217e28022a7e647b35a6af5dcfca91749"],
  "darwin-x64": ["goose-x86_64-apple-darwin.tar.gz", "5ad5594246841c759b34966e09ca421c09151b589183a8f1720e15e8395834ae"],
  "darwin-arm64": ["goose-aarch64-apple-darwin.tar.gz", "80d43c49b77302777e9d2fe32faf3c40c1028dafbea1e0a39b0378404a8a074b"],
  "win32-x64": ["goose-x86_64-pc-windows-msvc.zip", "1ab2117ceec37f95be4d3ad0cdb921d3e97fd8b0fa244046631ecf4b7619d502"],
};

export const GOOSE_TAB = "goose";

/** `{plugins: [...]}` from the file the plugin writes; missing or broken means none. */
export function installedPlugins(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(parsed?.plugins) ? parsed : { plugins: [] };
  } catch {
    return { plugins: [] };
  }
}

export function gooseEnabled(installed) {
  return Array.isArray(installed?.plugins) && installed.plugins.some((plugin) => plugin?.code === "goose");
}

export function gooseAsset(platform = process.platform, arch = process.arch) {
  const entry = ASSETS[`${platform}-${arch}`];
  if (!entry) return undefined;
  const [name, sha256] = entry;
  return { name, sha256, url: `https://github.com/aaif-goose/goose/releases/download/v${GOOSE_VERSION}/${name}` };
}

export function verifyDigest(bytes, sha256) {
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== sha256) throw new Error(`Goose download digest mismatch: expected ${sha256}, got ${digest}`);
}

/** Goose's declarative OpenAI-compatible provider for the node's models. */
export function gooseProviderJson(baseURL, models) {
  return {
    name: "pom",
    engine: "openai",
    display_name: "POM",
    description: "The models this POM node serves",
    api_key_env: "POM_API_KEY",
    base_url: `${baseURL.replace(/\/+$/, "")}/chat/completions`,
    models: models.map((model) => (model.contextWindow ? { name: model.id, context_limit: model.contextWindow } : { name: model.id })),
    supports_streaming: true,
  };
}

const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

/** The `goose` command on the panes' PATH: Goose with its root and the POM provider. */
export function gooseWrapper({ binary, root, model, windows }) {
  if (windows) {
    return [
      "@echo off",
      `set "GOOSE_PATH_ROOT=${root}"`,
      'set "GOOSE_PROVIDER=pom"',
      'set "GOOSE_DISABLE_KEYRING=1"',
      ...(model ? [`set "GOOSE_MODEL=${model}"`] : []),
      `"${binary}" %*`,
      "",
    ].join("\r\n");
  }
  return [
    "#!/bin/sh",
    `GOOSE_PATH_ROOT=${shellQuote(root)}`,
    "GOOSE_PROVIDER=pom",
    "GOOSE_DISABLE_KEYRING=1",
    ...(model ? [`GOOSE_MODEL=${shellQuote(model)}`] : []),
    `export GOOSE_PATH_ROOT GOOSE_PROVIDER GOOSE_DISABLE_KEYRING${model ? " GOOSE_MODEL" : ""}`,
    `exec ${shellQuote(binary)} "$@"`,
    "",
  ].join("\n");
}

function findBinary(dir, name) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      const found = findBinary(path, name);
      if (found) return found;
    } else if (entry === name) return path;
  }
  return undefined;
}

/** The pinned Goose under `dir`, downloaded and verified the first time. */
export async function ensureGoose({ dir, log = () => {}, platform = process.platform, arch = process.arch }) {
  const name = platform === "win32" ? "goose.exe" : "goose";
  const target = join(dir, GOOSE_VERSION, name);
  if (existsSync(target)) return target;
  const asset = gooseAsset(platform, arch);
  if (!asset) throw new Error(`Goose has no release for ${platform}-${arch}`);
  log(`downloading Goose ${GOOSE_VERSION}`);
  const response = await fetch(asset.url);
  if (!response.ok) throw new Error(`Goose download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  verifyDigest(bytes, asset.sha256);
  const staging = join(dir, `.${GOOSE_VERSION}.partial`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const archive = join(staging, asset.name);
  writeFileSync(archive, bytes);
  // `tar` unpacks both the tarballs and, on Windows (bsdtar), the zip.
  const unpacked = spawnSync("tar", ["-xf", archive, "-C", staging], { stdio: "ignore" });
  if (unpacked.status !== 0) throw new Error("could not unpack the Goose archive");
  rmSync(archive, { force: true });
  const found = findBinary(staging, name);
  if (!found) throw new Error("the Goose archive has no goose binary");
  if (found !== join(staging, name)) renameSync(found, join(staging, name));
  if (platform !== "win32") chmodSync(join(staging, name), 0o755);
  rmSync(join(dir, GOOSE_VERSION), { recursive: true, force: true });
  renameSync(staging, join(dir, GOOSE_VERSION));
  return target;
}

/** Writes the provider under `root` and the `goose` wrapper in `binDir`. */
export function configureGoose({ root, binDir, binary, llmBaseUrl, models, windows }) {
  const providers = join(root, "config", "custom_providers");
  mkdirSync(providers, { recursive: true });
  writeFileSync(join(providers, "pom.json"), `${JSON.stringify(gooseProviderJson(llmBaseUrl, models), null, 2)}\n`);
  const wrapper = join(binDir, windows ? "goose.cmd" : "goose");
  writeFileSync(wrapper, gooseWrapper({ binary, root, model: models[0]?.id ?? null, windows }));
  if (!windows) chmodSync(wrapper, 0o755);
}

/** Takes the `goose` command away; an open tab is left alone. */
export function removeGooseCommand({ binDir, windows }) {
  rmSync(join(binDir, windows ? "goose.cmd" : "goose"), { force: true });
}
