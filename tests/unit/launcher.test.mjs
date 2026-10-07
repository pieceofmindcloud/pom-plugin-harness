import assert from "node:assert/strict";
import { test } from "node:test";
import {
  herdrConfig,
  windowsPaneShell,
  withDefaultShell,
  listWorkspaceProjects,
  parseClientMessage,
  privateEnv,
  socketPath,
  terminalSize,
  withDefaultModel,
  withPomProvider,
  withTrustedFolder,
} from "../../runtime/launcher.mjs";

test("workspace listing returns visible immediate directories and safe fallback states", async (t) => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "harness-workspace-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "alpha"));
  mkdirSync(join(root, ".private"));
  writeFileSync(join(root, "notes.txt"), "ignored");
  assert.deepEqual(listWorkspaceProjects(root), { status: "ready", projects: ["alpha"] });
  assert.deepEqual(listWorkspaceProjects(join(root, "missing")), { status: "unavailable", projects: [] });
  assert.deepEqual(listWorkspaceProjects(""), { status: "unavailable", projects: [] });
  const empty = join(root, "empty");
  mkdirSync(empty);
  assert.deepEqual(listWorkspaceProjects(empty), { status: "empty", projects: [] });
});

test("herdr and pi get a private environment, never the host's herdr session", () => {
  const base = {
    PATH: "/opt/homebrew/bin:/usr/bin",
    HOME: "/Users/someone",
    HERDR_SOCKET_PATH: "/Users/someone/.config/herdr/sessions/fleet/herdr.sock",
    HERDR_SESSION: "fleet",
    HERDR_PANE_ID: "w1:p1",
    OPENAI_API_KEY: "sk-host",
    LANG: "pt_BR.UTF-8",
  };
  const result = privateEnv({
    platform: "linux",
    base,
    home: "/data/harness/data/home",
    binDir: "/data/harness/data/bin",
    herdrBin: "/data/harness/runtime/abc/bin/herdr",
    shell: "/bin/bash",
    apiKey: "sk-pom",
    socket: "/data/harness/data/home/herdr.sock",
  });
  assert.equal(result.HOME, "/data/harness/data/home");
  assert.equal(result.HERDR_SOCKET_PATH, "/data/harness/data/home/herdr.sock");
  assert.equal(result.HERDR_SESSION, undefined);
  assert.equal(result.HERDR_PANE_ID, undefined);
  assert.equal(result.OPENAI_API_KEY, undefined);
  assert.equal(result.POM_API_KEY, "sk-pom");
  assert.equal(result.LANG, "pt_BR.UTF-8");
  assert.ok(result.PATH.startsWith("/data/harness/data/bin:/data/harness/runtime/abc/bin:"));
  assert.ok(!result.PATH.includes("/opt/homebrew"));
  assert.equal(result.HERDR_CONFIG_PATH, "/data/harness/data/home/.config/herdr/config.toml");
  assert.equal(result.SHELL, "/bin/bash");
  assert.equal(result.BASH_SILENCE_DEPRECATION_WARNING, "1");
});

test("on Windows herdr's %APPDATA% and the system PATH stay private too", () => {
  const result = privateEnv({
    platform: "win32",
    base: {
      PATH: "C:\\Users\\someone\\bin;C:\\Windows\\System32",
      SYSTEMROOT: "C:\\Windows",
      APPDATA: "C:\\Users\\someone\\AppData\\Roaming",
      HERDR_SESSION: "fleet",
    },
    home: "D:\\pom\\harness\\data\\home",
    binDir: "D:\\pom\\harness\\data\\bin",
    herdrBin: "D:\\pom\\harness\\runtime\\abc\\bin\\herdr.exe",
    shell: "",
    apiKey: "sk-pom",
  });
  assert.equal(result.APPDATA, "D:\\pom\\harness\\data\\home\\AppData\\Roaming");
  assert.equal(result.LOCALAPPDATA, "D:\\pom\\harness\\data\\home\\AppData\\Local");
  assert.equal(
    result.HERDR_CONFIG_PATH,
    "D:\\pom\\harness\\data\\home\\AppData\\Roaming\\herdr\\config.toml",
  );
  assert.equal(
    result.PATH,
    "D:\\pom\\harness\\data\\bin;D:\\pom\\harness\\runtime\\abc\\bin;C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\WindowsPowerShell\\v1.0",
  );
  assert.equal(result.HERDR_SESSION, undefined);
  assert.equal(result.HERDR_SOCKET_PATH, undefined);
  assert.equal(result.SHELL, undefined, "herdr picks its Windows default shell");
});

test("the herdr socket path stays short enough for a Unix socket", () => {
  assert.equal(socketPath("/data/harness/data/home", "/tmp", "linux"), "/data/harness/data/home/herdr.sock");
  const long = `/Users/someone/Library/Application Support/pom/${"x".repeat(80)}/home`;
  const fallback = socketPath(long, "/tmp", "darwin");
  assert.match(fallback, /^\/tmp\/pom-harness-[0-9a-f]{16}\/herdr\.sock$/);
  assert.equal(socketPath(long, "/tmp", "darwin"), fallback, "stable for the same data directory");
  assert.equal(socketPath("D:\\pom\\home", "C:\\Temp", "win32"), undefined, "herdr's own default on Windows");
});

test("herdr panes start a non-login shell so the private PATH survives", () => {
  const config = herdrConfig("/bin/bash");
  assert.match(config, /\[terminal\]/);
  assert.match(config, /default_shell = "\/bin\/bash"/);
  assert.match(config, /shell_mode = "non_login"/);
  assert.match(config, /^onboarding = false$/m, "the first-run tour is skipped");
});

test("pi trusts the plugin's working folder once and keeps any saved decision", () => {
  assert.deepEqual(withTrustedFolder({}, "/data/w"), { "/data/w": true });
  assert.deepEqual(withTrustedFolder({ "/other": false }, "/data/w"), { "/other": false, "/data/w": true });
  assert.equal(withTrustedFolder({ "/data/w": false }, "/data/w"), undefined, "the user said no");
  assert.equal(withTrustedFolder({ "/data/w": true }, "/data/w"), undefined);
});

test("pi's POM provider follows the node's models and keeps the user's providers", () => {
  const current = { providers: { ollama: { baseUrl: "http://localhost:11434/v1" } } };
  const models = [{ id: "a", contextWindow: 65536, maxTokens: 65536 }, { id: "b" }];
  const next = withPomProvider(current, "http://127.0.0.1:8080/v1", models);
  assert.deepEqual(next.providers.ollama, current.providers.ollama);
  assert.deepEqual(next.providers.pom, {
    baseUrl: "http://127.0.0.1:8080/v1",
    api: "openai-completions",
    apiKey: "$POM_API_KEY",
    models: [{ id: "a", contextWindow: 65536, maxTokens: 65536 }, { id: "b" }],
  });
  assert.equal(withPomProvider(next, "http://127.0.0.1:8080/v1", []).providers.pom, undefined);
});

test("pi's default model moves to POM without overriding a real choice", () => {
  assert.deepEqual(withDefaultModel({}, ["a", "b"]), { defaultProvider: "pom", defaultModel: "a" });
  assert.equal(withDefaultModel({}, []), undefined);
  assert.equal(withDefaultModel({ defaultProvider: "pom", defaultModel: "b" }, ["a", "b"]), undefined);
  assert.deepEqual(withDefaultModel({ defaultProvider: "pom", defaultModel: "gone", theme: "dark" }, ["a"]), {
    defaultProvider: "pom",
    defaultModel: "a",
    theme: "dark",
  });
  assert.equal(withDefaultModel({ defaultProvider: "anthropic", defaultModel: "claude" }, ["a"]), undefined);
});

test("terminal size and browser messages are validated", () => {
  assert.deepEqual(terminalSize("/terminal?cols=200&rows=50"), { cols: 200, rows: 50 });
  assert.deepEqual(terminalSize("/terminal?cols=x"), { cols: 120, rows: 32 });
  assert.deepEqual(terminalSize("/terminal?cols=99999&rows=2"), { cols: 500, rows: 32 });
  assert.deepEqual(parseClientMessage(Buffer.from('{"type":"resize","cols":80,"rows":24}'), false), {
    type: "resize",
    cols: 80,
    rows: 24,
  });
  assert.deepEqual(parseClientMessage(Buffer.from('{"type":"resize","cols":1,"rows":1}'), false), { type: "ignore" });
  assert.deepEqual(parseClientMessage(Buffer.from("{not json"), false), { type: "input", data: "{not json" });
  assert.deepEqual(parseClientMessage(Buffer.from("ls\r"), false), { type: "input", data: "ls\r" });
  assert.deepEqual(parseClientMessage(Buffer.from([0x1b, 0x5b, 0x41]), true), { type: "input", data: "\x1b[A" });
});

test("the Windows pane shell puts the private PATH back before PowerShell", () => {
  const script = windowsPaneShell(["C:\\pom\\data\\bin", "C:\\pom\\bin"]);
  assert.match(script, /^@echo off\r\n/);
  assert.match(script, /set "PATH=C:\\pom\\data\\bin;C:\\pom\\bin;%PATH%"\r\n/);
  assert.match(script, /powershell\.exe -NoLogo\r\n$/);
});

test("an existing herdr config gains the plugin's shell only when it names none", () => {
  const old = "onboarding = false\n\n[terminal]\nshell_mode = \"non_login\"\n";
  assert.equal(withDefaultShell(old, "C:\\d\\pom-shell.cmd"), "onboarding = false\n\n[terminal]\ndefault_shell = \"C:\\\\d\\\\pom-shell.cmd\"\nshell_mode = \"non_login\"\n");
  assert.equal(withDefaultShell("onboarding = false\n", "/bin/sh"), "onboarding = false\n\n[terminal]\ndefault_shell = \"/bin/sh\"\n");
  assert.equal(withDefaultShell('[terminal]\ndefault_shell = "pwsh.exe"\n', "x"), undefined, "a chosen shell is kept");
  assert.equal(withDefaultShell("[terminal]\n", ""), undefined);
});
