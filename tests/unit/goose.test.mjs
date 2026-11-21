import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  GOOSE_VERSION,
  gooseAsset,
  gooseEnabled,
  gooseProviderJson,
  gooseWrapper,
  installedPlugins,
  verifyDigest,
} from "../../runtime/goose.mjs";

test("goose agent enabled only when the goose plugin is installed", () => {
  assert.equal(gooseEnabled({ plugins: [{ code: "goose", version: "0.1.0" }, { code: "harness", version: "0.4.0" }] }), true);
  assert.equal(gooseEnabled({ plugins: [{ code: "harness", version: "0.4.0" }] }), false);
  assert.equal(gooseEnabled(undefined), false);
  assert.equal(gooseEnabled({ plugins: "nope" }), false);
});

test("installed plugins are read from the file the plugin writes, missing means none", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-goose-"));
  const file = join(dir, "installed-plugins.json");
  assert.deepEqual(installedPlugins(file), { plugins: [] });
  writeFileSync(file, JSON.stringify({ plugins: [{ code: "goose", version: "0.1.0" }] }));
  assert.equal(gooseEnabled(installedPlugins(file)), true);
  writeFileSync(file, "{broken");
  assert.deepEqual(installedPlugins(file), { plugins: [] });
});

test("the pinned asset exists for each supported platform", () => {
  for (const [platform, arch] of [["linux", "x64"], ["linux", "arm64"], ["darwin", "x64"], ["darwin", "arm64"], ["win32", "x64"]]) {
    const asset = gooseAsset(platform, arch);
    assert.ok(asset, `${platform}-${arch}`);
    assert.match(asset.sha256, /^[0-9a-f]{64}$/);
    assert.ok(asset.url.includes(`/v${GOOSE_VERSION}/`));
  }
  assert.equal(gooseAsset("freebsd", "x64"), undefined);
});

test("a download with the wrong digest is refused", () => {
  const abc = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
  assert.doesNotThrow(() => verifyDigest(Buffer.from("abc"), abc));
  assert.throws(() => verifyDigest(Buffer.from("abd"), abc), /digest/);
});

test("goose provider points at POM and the key stays in env", () => {
  const file = gooseProviderJson("http://127.0.0.1:8080/v1/", [{ id: "qwen3", contextWindow: 32768 }, { id: "bare" }]);
  assert.equal(file.base_url, "http://127.0.0.1:8080/v1/chat/completions");
  assert.equal(file.api_key_env, "POM_API_KEY");
  assert.deepEqual(file.models, [{ name: "qwen3", context_limit: 32768 }, { name: "bare" }]);
  const posix = gooseWrapper({ binary: "/d/goose/goose", root: "/d/goose-root", model: "qwen3", windows: false });
  assert.match(posix, /GOOSE_PATH_ROOT='\/d\/goose-root'/);
  assert.match(posix, /GOOSE_PROVIDER=pom/);
  assert.match(posix, /GOOSE_MODEL='qwen3'/);
  assert.match(posix, /exec '\/d\/goose\/goose' "\$@"/);
  assert.doesNotMatch(posix, /POM_API_KEY=/);
  const cmd = gooseWrapper({ binary: "C:\\g\\goose.exe", root: "C:\\r", model: null, windows: true });
  assert.match(cmd, /set "GOOSE_PATH_ROOT=C:\\r"/);
  assert.match(cmd, /"C:\\g\\goose.exe" %\*/);
});
