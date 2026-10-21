// Run on native Windows against the packaged runtime. The browser sends \r for
// Enter; this covers the real WebSocket -> node-pty ConPTY -> herdr -> shell path.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";

assert.equal(process.platform, "win32", "this smoke test needs a native Windows ConPTY");
const stage = path.resolve("build/runtime-windows-x86_64");
const node = path.join(stage, "bin", "node.exe");
const herdrBin = path.join(stage, "bin", "herdr.exe");
const { WebSocket } = createRequire(path.join(stage, "app", "package.json"))("ws");
const root = mkdtempSync(path.join(tmpdir(), "pom-harness-windows-"));
const dataDir = path.join(root, "data");
const home = path.join(dataDir, "home");
const key = "test-key-not-a-real-secret";
const runEnv = (await import(pathToFileURL(path.join(stage, "launcher.mjs")).href)).privateEnv({
  platform: "win32", base: process.env, home, binDir: path.join(dataDir, "bin"),
  herdrBin, shell: path.join(dataDir, "bin", "pom-shell.cmd"), apiKey: key,
});
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, timeoutMs, description) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try { const result = await fn(); if (result) return result; }
    catch (error) { last = error; }
    await delay(500);
  }
  throw new Error(`${description} timed out: ${last?.message ?? "no result"}`);
}
function jsonLine(child) {
  return new Promise((resolve, reject) => {
    const lines = readline.createInterface({ input: child.stdout });
    lines.once("line", (line) => { lines.close(); resolve(JSON.parse(line)); });
    child.once("exit", (code) => reject(new Error(`process exited ${code} before ready`)));
  });
}
function herdr(...args) {
  return new Promise((resolve, reject) => execFile(herdrBin, args, { cwd: home, env: runEnv, timeout: 60_000 }, (err, stdout, stderr) => {
    if (err) reject(new Error(`herdr ${args.join(" ")}: ${stderr || err.message}`));
    else if (!stdout.trim()) resolve({});
    else if (!stdout.trimStart().startsWith("{")) resolve(stdout);
    else { const reply = JSON.parse(stdout); if (reply.error) reject(new Error(JSON.stringify(reply.error))); else resolve(reply.result); }
  }));
}
let mock;
let launcher;
let socket;
let logs = "";
try {
  mock = spawn(node, [path.resolve("tests/e2e/mock-pom-llm.mjs")], {
    env: { ...process.env, MOCK_LLM_API_KEY: key, MOCK_LLM_MODELS: "pom-test-model:32768" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const mockReady = await jsonLine(mock);
  launcher = spawn(node, [path.join(stage, "launcher.mjs")], {
    env: { ...process.env, HARNESS_POM_DATA_DIR: dataDir,
      HARNESS_POM_LLM_BASE_URL: `http://127.0.0.1:${mockReady.port}/v1`, HARNESS_POM_LLM_API_KEY: key },
    stdio: ["pipe", "pipe", "pipe"],
  });
  launcher.stderr.setEncoding("utf8");
  launcher.stderr.on("data", (text) => { logs += text; process.stderr.write(text); });
  const ready = await jsonLine(launcher);
  assert.equal(ready.status, "ready", JSON.stringify(ready));
  const status = await until(() => {
    const file = path.join(dataDir, "agents-status.json");
    if (!existsSync(file)) return undefined;
    const current = JSON.parse(readFileSync(file, "utf8"));
    return ["ready", "error"].includes(current.state) ? current : undefined;
  }, 180_000, "OpenCode setup");
  assert.equal(status.state, "ready", status.message);
  console.log("agents:", status.message);
  const agentsUrl = `http://127.0.0.1:${ready.port}/agents`;
  assert.equal((await fetch(agentsUrl)).status, 401, "agent setup state must require the plugin token");
  const agentResponse = await fetch(agentsUrl, { headers: { "x-pom-plugin-token": ready.token } });
  assert.equal(agentResponse.status, 200);
  assert.equal((await agentResponse.json()).state, "ready");
  const tabs = (await herdr("tab", "list")).tabs;
  assert(tabs.some((tab) => tab.label === "pi"), "pi tab missing");
  assert(tabs.some((tab) => tab.label === "opencode"), `OpenCode tab missing: ${JSON.stringify(tabs)}`);
  console.log("opencode tab exists");
  const agents = await herdr("agent", "list");
  console.log("agent state:", JSON.stringify(agents));
  const openCodeTab = tabs.find((item) => item.label === "opencode");
  const openCodePane = (await herdr("pane", "list")).panes.find((item) => item.tab_id === openCodeTab.tab_id);
  assert(openCodePane, "OpenCode pane missing");
  const paneText = await herdr("pane", "read", openCodePane.pane_id, "--source", "recent", "--format", "text");
  console.log("OpenCode pane:", JSON.stringify(paneText));
  assert(!String(paneText).includes("not compatible with the version of Windows"), "OpenCode installer placeholder was launched");

  const workspace = (await herdr("workspace", "list")).workspaces.find((item) => item.label === "POM");
  assert(workspace, "POM workspace missing");
  const tab = await herdr("tab", "create", "--workspace", workspace.workspace_id, "--cwd", root, "--label", "Input test", "--no-focus");
  const created = (await herdr("tab", "list")).tabs.find((item) => item.label === "Input test");
  assert(created, "new shell tab missing");
  await herdr("tab", "focus", created.tab_id);
  socket = new WebSocket(`ws://127.0.0.1:${ready.port}/terminal?cols=100&rows=30`, {
    headers: { "x-pom-plugin-token": ready.token },
  });
  let output = "";
  socket.on("message", (data) => { output = (output + data.toString()).slice(-40000); });
  await once(socket, "open");
  const target = path.join(root, "enter-ok.txt");
  await until(() => output.includes("PS ") && output.includes(path.basename(root)), 30_000, "herdr client rendering the PowerShell prompt");
  await delay(500);
  const command = `Set-Content -Path '${target.replaceAll("'", "''")}' -Value 'ok'`;
  for (const char of command) {
    socket.send(char);
    await delay(15);
  }
  await until(async () => String(await herdr("pane", "read", tab.root_pane.pane_id, "--source", "visible", "--format", "text")).includes("-Value 'ok'"), 15_000, "complete command before pressing Enter");
  socket.send("\r");
  await until(() => existsSync(target), 15_000, `Enter through ConPTY; latest terminal: ${JSON.stringify(output.slice(-400))}`);
  assert.equal(readFileSync(target, "utf8").trim(), "ok");
  console.log("Enter executed a PowerShell command from the browser terminal");
  assert(agents.agents?.some((agent) => agent.name === "opencode"), "OpenCode tab opened, but its agent did not start");
} catch (error) {
  console.error("Windows end-to-end failure:", error, "\nlauncher logs:", logs);
  throw error;
} finally {
  socket?.close();
  launcher?.stdin.end();
  mock?.kill();
  await delay(700);
  launcher?.kill();
  try { rmSync(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }); }
  catch (error) { console.warn("Windows temp cleanup deferred:", error.message); }
}
