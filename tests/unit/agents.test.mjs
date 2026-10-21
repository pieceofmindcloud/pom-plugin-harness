import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  bundledOpencodeBinary,
  configureAgents,
  hasCurrentAgentsChoice,
  hostAgentDirs,
  hostAgentExecutableNames,
  installAgents,
  isWindowsBatchCommand,
  installPlan,
  normalizeChoice,
  parsePomModels,
  preferredModel,
  withOpencodeProvider,
  terminalKeys,
  TerminalKeyDecoder,
} from "../../runtime/agents.mjs";
const manifest = { npm: { "opencode-ai": "1.18.32" } };

test("only current-format saved choices survive migration", () => {
  assert.equal(hasCurrentAgentsChoice({ schema: 1, savedAt: "now", agents: {} }), true);
  assert.equal(hasCurrentAgentsChoice({ savedAt: "old", agents: {} }), false);
  assert.equal(hasCurrentAgentsChoice(undefined), false);
});

test("automatic first-run setup enables only OpenCode and reuses a working host install", () => {
  const detected = { codex: { path: "/opt/homebrew/bin/codex" } };
  const choice = normalizeChoice(undefined, detected);
  assert.deepEqual(choice.agents, { opencode: { enabled: true, source: "bundled" } });
  assert.deepEqual(installPlan(manifest, choice), { npm: { "opencode-ai": "1.18.32" } });
  const host = normalizeChoice(undefined, { opencode: { path: "/a/opencode", version: "1" } });
  assert.deepEqual(host.agents, { opencode: { enabled: true, source: "host", path: "/a/opencode" } });
  assert.deepEqual(installPlan(manifest, host), { npm: {} });
});

test("legacy choices preserve the OpenCode decision but cannot install removed agents", () => {
  const saved = { agents: {
    claude: { enabled: true, source: "bundled" },
    codex: { enabled: true, source: "host", path: "/old/codex" },
    opencode: { enabled: false, source: "bundled" },
  } };
  const choice = normalizeChoice(saved, {});
  assert.deepEqual(choice.agents, { opencode: { enabled: false, source: "bundled" } });
  assert.deepEqual(installPlan(manifest, choice), { npm: {} });
  assert.deepEqual(normalizeChoice({ agents: { opencode: { enabled: "yes" } } }, {}).agents.opencode, { enabled: true, source: "bundled" });
  const missingHost = normalizeChoice({ agents: { opencode: { enabled: true, source: "host" } } }, {});
  assert.deepEqual(installPlan(manifest, missingHost), { npm: { "opencode-ai": "1.18.32" } });
});

test("agents are looked for on the POM's PATH, then where their installers put them", () => {
  const posix = hostAgentDirs({ platform: "linux", home: "/home/u", pathEnv: "/usr/bin:/home/u/.local/bin" });
  assert.deepEqual(posix.slice(0, 3), ["/usr/bin", "/home/u/.local/bin", "/home/u/.claude/local"]);
  assert.ok(posix.includes("/opt/homebrew/bin") && posix.includes("/home/u/.opencode/bin"));
  assert.equal(new Set(posix).size, posix.length);
  const windows = hostAgentDirs({ platform: "win32", home: "C:\\Users\\u", pathEnv: "C:\\Windows;C:\\tools" });
  assert.deepEqual(windows.slice(0, 3), ["C:\\Windows", "C:\\tools", "C:\\Users\\u\\AppData\\Roaming\\npm"]);
  assert.ok(windows.includes("C:\\Users\\u\\.opencode\\bin"));
  assert.deepEqual(hostAgentExecutableNames("opencode", "win32"), ["opencode.exe", "opencode.cmd", "opencode.bat"]);
  assert.deepEqual(hostAgentExecutableNames("opencode", "linux"), ["opencode"]);
  assert.equal(isWindowsBatchCommand("C:\\Users\\u\\AppData\\Roaming\\npm\\opencode.cmd", "win32"), true);
  assert.equal(isWindowsBatchCommand("/usr/bin/opencode", "linux"), false);
});

test("the bundled OpenCode binary comes from the exact platform package, never the npm installer placeholder", () => {
  const root = mkdtempSync(join(tmpdir(), "pom-opencode-packages-"));
  try {
    const binary = (name, file) => {
      const dir = join(root, name, "bin");
      mkdirSync(dir, { recursive: true });
      const target = join(dir, file);
      writeFileSync(target, "fixture");
      return target;
    };
    binary("opencode-ai", "opencode.exe");
    binary("opencode-windows-arm64", "opencode.exe");
    const baseline = binary("opencode-windows-x64-baseline", "opencode.exe");
    assert.equal(bundledOpencodeBinary(root, "win32", "x64"), baseline);
    const native = binary("opencode-windows-x64", "opencode.exe");
    assert.equal(bundledOpencodeBinary(root, "win32", "x64"), native);
    assert.equal(bundledOpencodeBinary(root, "darwin", "arm64"), undefined);
    const mac = binary("opencode-darwin-arm64", "opencode");
    assert.equal(bundledOpencodeBinary(root, "darwin", "arm64"), mac);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows host command shims are invoked with call from the generated agent wrapper", async () => {
  const root = mkdtempSync(join(tmpdir(), "pom-harness-windows-shim-"));
  try {
    const hostCommand = join(root, "opencode.cmd");
    writeFileSync(hostCommand, "@echo off\r\necho opencode 1.2.3\r\n");
    mkdirSync(join(root, "data", "agents", "fcc-old"), { recursive: true });
    mkdirSync(join(root, "data", "agents", "npm-old"), { recursive: true });
    mkdirSync(join(root, "data", "agents", "real-bin"), { recursive: true });
    mkdirSync(join(root, "data", "bin"), { recursive: true });
    writeFileSync(join(root, "data", "bin", "claude.cmd"), "old");
    writeFileSync(join(root, "data", "bin", "codex.cmd"), "old");
    await installAgents({
      manifest: { npm: {} },
      choice: {
        agents: {
          opencode: { enabled: true, source: "host", path: hostCommand },
        },
      },
      dataDir: join(root, "data"),
      runEnv: {},
      nodeBin: "node.exe",
      npmCli: "npm-cli.js",
      binDir: join(root, "data", "bin"),
      windows: true,
      log: () => {},
    });
    const wrapper = readFileSync(join(root, "data", "bin", "opencode.cmd"), "utf8");
    assert.match(wrapper, /^@echo off\r\nset "CHROME_DEVTOOLS_AXI_SESSION=opencode"\r\ncall ".+opencode\.cmd" %\*\r\n$/);
    for (const name of ["fcc-old", "npm-old", "real-bin"]) assert.equal(existsSync(join(root, "data", "agents", name)), false);
    for (const name of ["claude.cmd", "codex.cmd"]) assert.equal(existsSync(join(root, "data", "bin", name)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the stable model name wins over the per-deployment alias", () => {
  assert.equal(preferredModel(["m@d-159b6317", "m"]), "m");
  assert.equal(preferredModel(["only@d-1"]), "only@d-1");
});

test("opencode: only the pom provider is managed, the user's providers and choice stay", () => {
  const user = {
    provider: { mine: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://x/v1" } } },
    model: "mine/big",
    theme: "tokyonight",
  };
  const next = withOpencodeProvider(user, "http://127.0.0.1:8080/v1", [{ id: "a" }, { id: "a@d-1" }]);
  assert.deepEqual(next.provider.mine, user.provider.mine);
  assert.equal(next.model, "mine/big", "a real choice is never replaced");
  assert.equal(next.theme, "tokyonight");
  assert.deepEqual(next.provider.pom.options, { baseURL: "http://127.0.0.1:8080/v1", apiKey: "{env:POM_API_KEY}" });
  assert.deepEqual(Object.keys(next.provider.pom.models), ["a", "a@d-1"]);
  assert.equal(withOpencodeProvider({}, "u", [{ id: "a@d-1" }, { id: "a" }]).model, "pom/a");
  assert.equal(withOpencodeProvider({ model: "pom/gone" }, "u", [{ id: "b" }]).model, "pom/b", "a vanished POM model is replaced");
  assert.equal(withOpencodeProvider(next, "u", []).provider.pom, undefined);
});

test("the POM's per-model limits are read from /v1/models", () => {
  const body = {
    data: [
      { id: "qwen", context_length: 65536, max_input_tokens: 65536, max_tokens: 65536 },
      { id: "qwen@d-1", top_provider: { context_length: 32768, max_completion_tokens: 32768 } },
      { id: "pending", context_length: null, max_tokens: null },
      { id: "qwen", context_length: 1 },
      { id: "" },
    ],
  };
  assert.deepEqual(parsePomModels(body), [
    { id: "qwen", contextWindow: 65536, maxTokens: 65536 },
    { id: "qwen@d-1", contextWindow: 32768, maxTokens: 32768 },
    { id: "pending" },
  ]);
  assert.deepEqual(parsePomModels({}), []);
});

test("every agent gets the context window of the POM model it runs", () => {
  const models = [{ id: "qwen", contextWindow: 65536, maxTokens: 65536 }, { id: "pending" }];
  const opencode = withOpencodeProvider({}, "u", models).provider.pom.models;
  assert.deepEqual(opencode.qwen, { name: "qwen", limit: { context: 65536, input: 65536, output: 65536 } });
  assert.deepEqual(opencode.pending, { name: "pending" }, "unknown limits leave opencode's defaults");

});

test("configuration updates only OpenCode, leaving other agents' private settings untouched", () => {
  const root = mkdtempSync(join(tmpdir(), "pom-harness-config-"));
  try {
    const home = join(root, "home");
    mkdirSync(join(home, ".fcc"), { recursive: true });
    writeFileSync(join(home, ".fcc", ".env"), "MODEL=user-model\n");
    writeFileSync(join(home, ".claude.json"), "{}\n");
    configureAgents({ home, llmBaseUrl: "http://pom/v1", models: [{ id: "qwen", contextWindow: 65536, maxTokens: 4096 }] });
    const config = JSON.parse(readFileSync(join(home, ".config", "opencode", "opencode.json"), "utf8"));
    assert.equal(config.model, "pom/qwen");
    assert.equal(config.provider.pom.models.qwen.limit.output, 4096);
    assert.equal(readFileSync(join(home, ".fcc", ".env"), "utf8"), "MODEL=user-model\n");
    assert.equal(readFileSync(join(home, ".claude.json"), "utf8"), "{}\n");
    assert.equal(existsSync(join(home, ".codex")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the agent chooser reads Enter, arrows and keys however the terminal encodes them", () => {
  // Plain bytes (macOS, Linux): one read may carry several keys.
  assert.deepEqual(terminalKeys("\r"), ["\r"]);
  assert.deepEqual(terminalKeys("\n"), ["\r"]);
  assert.deepEqual(terminalKeys("\r\n"), ["\r"]);
  assert.deepEqual(terminalKeys(" \x1b[B\x1b[A\r"), [" ", "\x1b[B", "\x1b[A", "\r"]);
  assert.deepEqual(terminalKeys("\x1bOB"), ["\x1bOB"]);
  assert.deepEqual(terminalKeys("\x1b"), ["\x1b"]);
  // Windows ConPTY win32-input-mode: Vk;Sc;Uc;Kd;Cs;Rc_, a press and a release per key.
  assert.deepEqual(terminalKeys("\x1b[13;28;13;1;0;1_\x1b[13;28;13;0;0;1_"), ["\r"]);
  assert.deepEqual(terminalKeys("\x1b[40;80;0;1;256;1_\x1b[40;80;0;0;256;1_"), ["\x1b[B"]);
  assert.deepEqual(terminalKeys("\x1b[38;72;0;1;256;1_"), ["\x1b[A"]);
  assert.deepEqual(terminalKeys("\x1b[32;57;32;1;0;1_\x1b[65;30;97;1;0;1_"), [" ", "a"]);
  assert.deepEqual(terminalKeys("\x1b[27;1;27;1;0;1_"), ["\x1b"]);
  assert.deepEqual(terminalKeys("\x1b[67;46;3;1;8;1_"), ["\x03"]);
  assert.deepEqual(terminalKeys("\x1b[67;46;99;1;8;1_"), ["\x03"], "Ctrl+C can arrive as the printable codepoint plus a modifier");
  assert.deepEqual(terminalKeys("\x1b[16;42;0;1;16;1_"), []);
  // The kitty keyboard protocol and xterm's modifyOtherKeys.
  assert.deepEqual(terminalKeys("\x1b[13u"), ["\r"]);
  assert.deepEqual(terminalKeys("\x1b[13;1u"), ["\r"]);
  assert.deepEqual(terminalKeys("\x1b[27u"), ["\x1b"]);
  assert.deepEqual(terminalKeys("\x1b[99;5u"), ["\x03"]);
  assert.deepEqual(terminalKeys("\x1b[99;5:3u"), [], "key releases are ignored");
  assert.deepEqual(terminalKeys("\x1b[27;1;13~"), ["\r"]);
  assert.deepEqual(terminalKeys("\x1b[27;5;99~"), ["\x03"]);
  assert.deepEqual(terminalKeys("\x1b[1;5A"), ["\x1b[A"], "modified arrows remain usable in the chooser");

  const decoder = new TerminalKeyDecoder();
  assert.deepEqual(decoder.feed("\x1b[13;28;"), []);
  assert.deepEqual(decoder.feed("13;1;0;1_"), ["\r"], "a Windows key event may span reads");
  assert.deepEqual(decoder.feed("\x1b[1;5"), []);
  assert.deepEqual(decoder.feed("A"), ["\x1b[A"]);
  assert.deepEqual(decoder.feed("\r"), ["\r"]);
  assert.deepEqual(decoder.feed("\n"), [], "split CRLF still means one Enter");
  assert.deepEqual(decoder.feed("\x1b"), []);
  assert.equal(decoder.waitingForEscape, true);
  assert.deepEqual(decoder.flushEscape(), ["\x1b"]);
});
