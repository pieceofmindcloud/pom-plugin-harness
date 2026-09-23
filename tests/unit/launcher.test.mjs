import assert from "node:assert/strict";
import { test } from "node:test";
import {
  herdrConfig,
  parseClientMessage,
  privateEnv,
  socketPath,
  terminalSize,
  withDefaultModel,
  withPomProvider,
  withTrustedFolder,
} from "../../runtime/launcher.mjs";

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
    home: "/data/pi_harness/data/home",
    binDir: "/data/pi_harness/data/bin",
    herdrBin: "/data/pi_harness/runtime/abc/bin/herdr",
    shell: "/bin/bash",
    apiKey: "sk-pom",
    socket: "/data/pi_harness/data/home/herdr.sock",
  });
  assert.equal(result.HOME, "/data/pi_harness/data/home");
  assert.equal(result.HERDR_SOCKET_PATH, "/data/pi_harness/data/home/herdr.sock");
  assert.equal(result.HERDR_SESSION, undefined);
  assert.equal(result.HERDR_PANE_ID, undefined);
  assert.equal(result.OPENAI_API_KEY, undefined);
  assert.equal(result.POM_API_KEY, "sk-pom");
  assert.equal(result.LANG, "pt_BR.UTF-8");
  assert.ok(result.PATH.startsWith("/data/pi_harness/data/bin:/data/pi_harness/runtime/abc/bin:"));
  assert.ok(!result.PATH.includes("/opt/homebrew"));
  assert.equal(result.HERDR_CONFIG_PATH, "/data/pi_harness/data/home/.config/herdr/config.toml");
  assert.equal(result.SHELL, "/bin/bash");
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
    home: "D:\\pom\\pi_harness\\data\\home",
    binDir: "D:\\pom\\pi_harness\\data\\bin",
    herdrBin: "D:\\pom\\pi_harness\\runtime\\abc\\bin\\herdr.exe",
    shell: "",
    apiKey: "sk-pom",
  });
  assert.equal(result.APPDATA, "D:\\pom\\pi_harness\\data\\home\\AppData\\Roaming");
  assert.equal(result.LOCALAPPDATA, "D:\\pom\\pi_harness\\data\\home\\AppData\\Local");
  assert.equal(
    result.HERDR_CONFIG_PATH,
    "D:\\pom\\pi_harness\\data\\home\\AppData\\Roaming\\herdr\\config.toml",
  );
  assert.equal(
    result.PATH,
    "D:\\pom\\pi_harness\\data\\bin;D:\\pom\\pi_harness\\runtime\\abc\\bin;C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\WindowsPowerShell\\v1.0",
  );
  assert.equal(result.HERDR_SESSION, undefined);
  assert.equal(result.HERDR_SOCKET_PATH, undefined);
  assert.equal(result.SHELL, undefined, "herdr picks its Windows default shell");
});

test("the herdr socket path stays short enough for a Unix socket", () => {
  assert.equal(socketPath("/data/pi_harness/data/home", "/tmp", "linux"), "/data/pi_harness/data/home/herdr.sock");
  const long = `/Users/someone/Library/Application Support/pom/${"x".repeat(80)}/home`;
  const fallback = socketPath(long, "/tmp", "darwin");
  assert.match(fallback, /^\/tmp\/pom-pi-[0-9a-f]{16}\/herdr\.sock$/);
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
  const next = withPomProvider(current, "http://127.0.0.1:8080/v1", ["a", "b"]);
  assert.deepEqual(next.providers.ollama, current.providers.ollama);
  assert.deepEqual(next.providers.pom, {
    baseUrl: "http://127.0.0.1:8080/v1",
    api: "openai-completions",
    apiKey: "$POM_API_KEY",
    models: [{ id: "a" }, { id: "b" }],
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
