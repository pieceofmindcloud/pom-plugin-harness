import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("dev rebuild replaces stale agent pins and scripts rather than repackaging removed agents", async () => {
  const build = join(root, "build");
  mkdirSync(build, { recursive: true });
  const stage = mkdtempSync(join(build, "runtime-test-"));
  const platform = stage.slice(join(build, "runtime-").length);
  const out = mkdtempSync(join(tmpdir(), "pom-harness-dev-runtime-"));
  try {
    writeFileSync(join(stage, "agents.json"), JSON.stringify({
      npm: { "opencode-ai": "1.2.3", "chrome-devtools-axi": "0.1.44", "@openai/codex": "1.0.0" },
      uv: { version: "old" }, fcc: { commit: "old" },
    }));
    writeFileSync(join(stage, "runtime.json"), JSON.stringify({ pi_version: "0.87.1", agents: { old: true } }));
    for (const name of ["launcher.mjs", "agent-shim.mjs", "agents.mjs"]) writeFileSync(join(stage, name), "old script");
    const shellPath = (file) => process.platform === "win32"
      ? execFileSync("cygpath", ["-u", file], { encoding: "utf8" }).trim()
      : file;
    const shellOut = shellPath(out);
    execFileSync("bash", ["./scripts/dev-runtime.sh"], {
      cwd: root,
      env: { ...process.env, POM_PLUGIN_OUT_DIR: shellOut, POM_PLUGIN_PLATFORM: platform },
    });
    const archive = shellPath(join(out, `runtime-${platform}.tar.gz`));
    const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).split("\n");
    assert.equal(entries.some((entry) => entry.endsWith("agent-shim.mjs")), false);
    assert.equal(entries.filter((entry) => /(?:^|\/)launcher\.mjs$/.test(entry)).length, 1);
    const extracted = join(out, "extracted");
    mkdirSync(extracted);
    execFileSync("tar", ["-xzf", archive, "-C", shellPath(extracted), "launcher.mjs", "agents.mjs"]);
    const { withPomProvider } = await import(pathToFileURL(join(extracted, "launcher.mjs")));
    assert.deepEqual(withPomProvider({}, "http://pom/v1", [{ id: "qwen", contextWindow: 32768, maxTokens: 4096 }]).providers.pom.models,
      [{ id: "qwen", contextWindow: 32768, maxTokens: 4096 }]);
    const agents = JSON.parse(execFileSync("tar", ["-xOf", archive, "agents.json"], { encoding: "utf8" }));
    assert.deepEqual(agents, { npm: { "opencode-ai": "1.2.3", "chrome-devtools-axi": "0.1.44" } });
    const runtime = JSON.parse(execFileSync("tar", ["-xOf", archive, "runtime.json"], { encoding: "utf8" }));
    assert.deepEqual(runtime.agents, agents);
    assert.equal(runtime.pi_version, "0.87.1");
  } finally {
    rmSync(stage, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});
