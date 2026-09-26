import assert from "node:assert/strict";
import { test } from "node:test";
import {
  claudeLimitsEnv,
  fccSourceBuildEnv,
  hostAgentDirs,
  installPlan,
  normalizeChoice,
  parsePomModels,
  preferredModel,
  withClaudeReady,
  withCodexHookTrust,
  withCodexTrust,
  withFccSettings,
  withOpencodeProvider,
  withOutputCeiling,
  withPomContextWindows,
} from "../../runtime/agents.mjs";
import { relayTarget } from "../../runtime/launcher.mjs";

const manifest = { npm: { "@anthropic-ai/claude-code": "2.1.281", "@openai/codex": "0.156.1", "opencode-ai": "1.18.32" } };

test("by default every agent is on, taken from this machine when it is installed there", () => {
  const detected = { codex: { path: "/opt/homebrew/bin/codex", version: "0.150.0" } };
  const choice = normalizeChoice(undefined, detected);
  assert.deepEqual(choice.agents, {
    claude: { enabled: true, source: "bundled" },
    codex: { enabled: true, source: "host", path: "/opt/homebrew/bin/codex" },
    opencode: { enabled: true, source: "bundled" },
  });
  assert.deepEqual(installPlan(manifest, choice), {
    npm: { "@anthropic-ai/claude-code": "2.1.281", "opencode-ai": "1.18.32" },
    fcc: true,
  });
});

test("a saved choice is kept, and falls back when the machine's agent is gone", () => {
  const saved = {
    agents: {
      claude: { enabled: false, source: "bundled" },
      codex: { enabled: true, source: "host", path: "/old/codex" },
      opencode: { enabled: true, source: "bundled" },
    },
  };
  const detected = { opencode: { path: "/usr/local/bin/opencode", version: "1.0.0" } };
  const choice = normalizeChoice(saved, detected);
  assert.deepEqual(choice.agents.claude, { enabled: false, source: "bundled" });
  assert.deepEqual(choice.agents.codex, { enabled: true, source: "bundled" }, "no longer on the machine: download it");
  assert.deepEqual(choice.agents.opencode, { enabled: true, source: "bundled" }, "downloading was chosen over the machine's");
  assert.deepEqual(normalizeChoice({ agents: { claude: { enabled: "yes" } } }, {}).agents.claude, { enabled: true, source: "bundled" });
});

test("FCC is installed only for Claude Code or Codex, npm only for what is downloaded", () => {
  const onlyOpencode = normalizeChoice({ agents: { claude: { enabled: false }, codex: { enabled: false } } }, {});
  assert.deepEqual(installPlan(manifest, onlyOpencode), { npm: { "opencode-ai": "1.18.32" }, fcc: false });
  const allHost = normalizeChoice(undefined, {
    claude: { path: "/a/claude", version: "1" },
    codex: { path: "/a/codex", version: "1" },
    opencode: { path: "/a/opencode", version: "1" },
  });
  assert.deepEqual(installPlan(manifest, allHost), { npm: {}, fcc: true });
  const none = normalizeChoice({ agents: { claude: { enabled: false }, codex: { enabled: false }, opencode: { enabled: false } } }, {});
  assert.deepEqual(installPlan(manifest, none), { npm: {}, fcc: false });
});

test("FCC ZIP builds receive deterministic version metadata from their pinned commit", () => {
  const commit = "0123456789abcdef0123456789abcdef01234567";
  assert.deepEqual(fccSourceBuildEnv(commit), {
    SETUPTOOLS_SCM_PRETEND_VERSION: "0.0.0+g0123456789ab",
    SETUPTOOLS_SCM_PRETEND_VERSION_FOR_FREE_CLAUDE_CODE: "0.0.0+g0123456789ab",
  });
  assert.throws(() => fccSourceBuildEnv("not-a-commit"), /invalid free-claude-code commit/);
});

test("agents are looked for on the POM's PATH, then where their installers put them", () => {
  const posix = hostAgentDirs({ platform: "linux", home: "/home/u", pathEnv: "/usr/bin:/home/u/.local/bin" });
  assert.deepEqual(posix.slice(0, 3), ["/usr/bin", "/home/u/.local/bin", "/home/u/.claude/local"]);
  assert.ok(posix.includes("/opt/homebrew/bin") && posix.includes("/home/u/.opencode/bin"));
  assert.equal(new Set(posix).size, posix.length);
  const windows = hostAgentDirs({ platform: "win32", home: "C:\\Users\\u", pathEnv: "C:\\Windows;C:\\tools" });
  assert.deepEqual(windows.slice(0, 3), ["C:\\Windows", "C:\\tools", "C:\\Users\\u\\AppData\\Roaming\\npm"]);
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

  const claude = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "65536", CLAUDE_CODE_MAX_OUTPUT_TOKENS: "65536" };
  assert.deepEqual(claudeLimitsEnv("MODEL=llamacpp/qwen\n", models), claude);
  assert.deepEqual(claudeLimitsEnv('MODEL="llamacpp/qwen"\n', models), claude);
  assert.deepEqual(claudeLimitsEnv("MODEL=llamacpp/pending\n", models), {});
  assert.deepEqual(claudeLimitsEnv("MODEL=open_router/x\n", models), {}, "a user's own provider is left alone");

  const catalog = {
    models: [
      { slug: "llamacpp/qwen", context_window: 200000, max_context_window: 200000, priority: 0 },
      { slug: "llamacpp/pending", context_window: 200000 },
    ],
  };
  const patched = withPomContextWindows(catalog, models);
  assert.deepEqual(patched.models[0], { slug: "llamacpp/qwen", context_window: 65536, max_context_window: 65536, priority: 0 });
  assert.equal(patched.models[1], catalog.models[1]);
  assert.equal(withPomContextWindows(catalog, [{ id: "pending" }]), undefined);
  assert.equal(withPomContextWindows({}, models), undefined);
});

test("a relayed request without an output limit gets the POM model's ceiling, not the node's 512", () => {
  const models = [{ id: "qwen", contextWindow: 65536, maxTokens: 65536 }, { id: "pending" }];
  assert.deepEqual(withOutputCeiling({ model: "qwen", stream: true }, models), { model: "qwen", stream: true, max_tokens: 65536 });
  assert.equal(withOutputCeiling({ model: "qwen", max_tokens: 100 }, models), undefined);
  assert.equal(withOutputCeiling({ model: "qwen", max_completion_tokens: 100 }, models), undefined);
  assert.equal(withOutputCeiling({ model: "pending" }, models), undefined);
  assert.equal(withOutputCeiling({ model: "other" }, models), undefined);
  assert.equal(withOutputCeiling([], models), undefined);
});

test("FCC: the plugin's keys are set and every other line is the user's", () => {
  const user = [
    "# Managed by Free Claude Code.",
    "FCC_CONFIG_SCHEMA=1",
    "NVIDIA_NIM_API_KEY=nvapi-user",
    "MODEL=nvidia_nim/nemotron",
    "ANTHROPIC_AUTH_TOKEN=kept-token",
    "",
  ].join("\n");
  const owned = { HOST: "127.0.0.1", PORT: "18090", PROXY_AUTH_ENABLED: "true", LLAMACPP_BASE_URL: "http://127.0.0.1:1/relay/s/v1" };
  const next = withFccSettings(user, owned, ["a"], "new-token");
  assert.match(next, /^NVIDIA_NIM_API_KEY=nvapi-user$/m);
  assert.match(next, /^MODEL=nvidia_nim\/nemotron$/m, "the user's model is kept");
  assert.match(next, /^ANTHROPIC_AUTH_TOKEN=kept-token$/m, "the existing proxy token is kept");
  assert.match(next, /^HOST=127\.0\.0\.1$/m);
  assert.match(next, /^LLAMACPP_BASE_URL=http:\/\/127\.0\.0\.1:1\/relay\/s\/v1$/m);
  const fresh = withFccSettings(undefined, owned, ["a@d-2", "a"], "new-token");
  assert.match(fresh, /^FCC_CONFIG_SCHEMA=1$/m);
  assert.match(fresh, /^MODEL=llamacpp\/a$/m);
  assert.match(fresh, /^ANTHROPIC_AUTH_TOKEN=new-token$/m);
  assert.match(withFccSettings("MODEL=llamacpp/gone\n", owned, ["b"], "t"), /^MODEL=llamacpp\/b$/m);
  assert.equal(withFccSettings(fresh, owned, ["a@d-2", "a"], "other"), fresh, "stable once written");
});

test("Claude Code and Codex start without onboarding or trust prompts, once", () => {
  const claude = withClaudeReady({ projects: { "/w": { hasTrustDialogAccepted: false } }, theme: "dark" }, "/w");
  assert.equal(claude.hasCompletedOnboarding, true);
  assert.equal(claude.projects["/w"].hasTrustDialogAccepted, false, "the user's decision is kept");
  assert.equal(claude.theme, "dark");
  const fresh = withClaudeReady({}, "/w").projects["/w"];
  assert.equal(fresh.hasTrustDialogAccepted, true);
  assert.equal(fresh.hasClaudeMdExternalIncludesApproved, false, "files outside the workspace stay out");
  assert.equal(fresh.hasClaudeMdExternalIncludesWarningShown, true);
  const approved = { projects: { "/w": { hasClaudeMdExternalIncludesApproved: true } } };
  assert.equal(withClaudeReady(approved, "/w").projects["/w"].hasClaudeMdExternalIncludesApproved, true);
  const codex = withCodexTrust('model = "x"\n', "/w");
  assert.equal(codex, 'model = "x"\n\n[projects."/w"]\ntrust_level = "trusted"\n');
  assert.equal(withCodexTrust(codex, "/w"), undefined);
});

test("herdr's Codex hook is trusted with the hash Codex computes, user hooks are not", () => {
  // Written by Codex 0.156.1 after trusting this hook by hand.
  const home = "/private/tmp/claude-501/-Users-jairpereira-Sites-pom-plugin-deepseek-harness/60f6b193-5442-4ca1-9c24-2057a952f112/scratchpad/pi-e2e-data/pi_harness/data/home";
  const hooksPath = `${home}/.codex/hooks.json`;
  const herdrHook = { type: "command", command: `bash '${home}/.codex/herdr-agent-state.sh' session`, timeout: 10 };
  const userHook = { type: "command", command: "echo mine" };
  const hooks = { hooks: { SessionStart: [{ hooks: [herdrHook] }, { hooks: [userHook] }] } };
  const header = `[hooks.state.${JSON.stringify(`${hooksPath}:session_start:0:0`)}]`;
  const trusted = withCodexHookTrust('model = "x"\n', hooks, hooksPath);
  assert.equal(
    trusted,
    `model = "x"\n\n${header}\ntrusted_hash = "sha256:e4b97afc351b5430f337c866687913f92b810249424b65d8f30f8d7102a933f0"\n`,
  );
  assert.equal(withCodexHookTrust(trusted, hooks, hooksPath), undefined);
  const stale = `${header}\nenabled = false\ntrusted_hash = "sha256:old"\n\n[other]\nx = 1\n`;
  const updated = withCodexHookTrust(stale, hooks, hooksPath);
  assert.match(updated, /enabled = false\ntrusted_hash = "sha256:e4b97afc/, "the user's enabled choice stays");
  assert.match(updated, /\[other\]\nx = 1\n$/);
});

test("the relay maps only its secret path onto the POM /v1", () => {
  assert.equal(relayTarget("/relay/s3cret/v1/chat/completions", "s3cret", "http://127.0.0.1:8080/v1"), "http://127.0.0.1:8080/v1/chat/completions");
  assert.equal(relayTarget("/relay/s3cret/v1/models?x=1", "s3cret", "http://h/v1"), "http://h/v1/models?x=1");
  assert.equal(relayTarget("/relay/wrong/v1/models", "s3cret", "http://h/v1"), undefined);
  assert.equal(relayTarget("/terminal", "s3cret", "http://h/v1"), undefined);
});
