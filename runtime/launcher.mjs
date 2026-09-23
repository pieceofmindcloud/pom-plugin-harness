// Supervisor of herdr and a pi coding agent inside the POM plugin.
//
// The plugin library starts this script with the Node runtime shipped next to
// it, passing the model endpoint and API key the POM handed over
// (`PI_POM_LLM_BASE_URL`, `PI_POM_LLM_API_KEY`). It:
//
// - runs every herdr and pi process with a private, explicit environment:
//   `HOME` under the plugin data directory and no inherited `HERDR_*`
//   variables, so it never talks to a herdr session the host user runs;
// - keeps pi's `models.json` pointed at the POM (the list follows the node's
//   `/v1/models`) and sets pi's default model only while nobody chose one;
// - starts the official `herdr server` and makes sure a "POM" workspace with
//   a pi agent exists;
// - serves a loopback terminal endpoint that only the POM node reaches (it
//   mounts it at `/api/ui/plugins/<code>/proxy` and adds `x-pom-plugin-token`):
//   each WebSocket gets its own pseudo-terminal running the herdr client.
//
// Protocol with the plugin library: exactly one JSON line on stdout once
// ready (`{"status":"ready","port":N,"token":"..."}`) or failed
// (`{"status":"error","error":"..."}`). Logs go to stderr. The process exits
// when stdin closes, so it never outlives the plugin host.

import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "app", "package.json"));
const env = process.env;
const isWindows = process.platform === "win32";
const dataDir = env.PI_POM_DATA_DIR || join(here, "data");
const home = join(dataDir, "home");
const workspace = join(dataDir, "workspace");
const binDir = join(dataDir, "bin");
const llmBaseUrl = (env.PI_POM_LLM_BASE_URL || "").replace(/\/+$/, "");
const llmApiKey = env.PI_POM_LLM_API_KEY || "";
const herdrBin = join(here, "bin", isWindows ? "herdr.exe" : "herdr");
const nodeBin = process.execPath;
const piCli = join(here, "app", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
const TOKEN_HEADER = "x-pom-plugin-token";
const MODEL_POLL_MS = Number(env.PI_POM_MODEL_POLL_MS || 15_000);
const PROVIDER = "pom";
const token = randomBytes(32).toString("base64url");

let server;
let reported = false;

function log(message) {
  process.stderr.write(`pi-pom: ${message}\n`);
}

function report(value) {
  if (reported) return;
  reported = true;
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function fail(error) {
  const message = error instanceof Error ? error.message : String(error);
  log(message);
  report({ status: "error", error: message });
  shutdown(1);
}

function shutdown(code = 0) {
  if (server && server.exitCode === null) server.kill("SIGTERM");
  setTimeout(() => process.exit(code), 300).unref();
}

// --- Private environment ----------------------------------------------------

/**
 * Unix socket paths are limited to about 104 bytes on macOS. Keep herdr's
 * socket under the plugin data directory when it fits, else in a private
 * directory under the system temp dir named after that data directory.
 */
export function socketPath(homeDir, tempDir = tmpdir()) {
  if (isWindows) return undefined;
  const preferred = join(homeDir, "herdr.sock");
  if (Buffer.byteLength(preferred) <= 90) return preferred;
  const id = createHash("sha256").update(homeDir).digest("hex").slice(0, 16);
  return join(tempDir, `pom-pi-${id}`, "herdr.sock");
}

/**
 * The only environment herdr, its panes and pi ever see. Nothing is copied
 * from the POM process but the few variables a shell needs, so a `HERDR_*`
 * or provider key of the host never leaks in.
 */
export function privateEnv(options) {
  const keep = ["LANG", "LC_ALL", "LC_CTYPE", "TZ", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP"];
  const result = {};
  for (const name of keep) if (options.base[name] !== undefined) result[name] = options.base[name];
  const system = isWindows ? [options.base.PATH ?? ""] : ["/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  Object.assign(result, {
    HOME: options.home,
    USERPROFILE: options.home,
    PATH: [options.binDir, dirname(options.herdrBin), ...system].join(isWindows ? ";" : ":"),
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    SHELL: options.shell,
    HERDR_CONFIG_PATH: join(options.home, ".config", "herdr", "config.toml"),
    PI_CODING_AGENT_DIR: join(options.home, ".pi", "agent"),
    POM_API_KEY: options.apiKey,
  });
  if (options.socket) result.HERDR_SOCKET_PATH = options.socket;
  return result;
}

function pickShell() {
  if (isWindows) return "";
  return ["/bin/bash", "/usr/bin/bash", "/bin/sh"].find((candidate) => existsSync(candidate)) ?? "/bin/sh";
}

/** `pi` on the panes' PATH always runs the bundled release on the bundled Node. */
function writePiWrapper() {
  mkdirSync(binDir, { recursive: true });
  if (isWindows) {
    writeFileSync(join(binDir, "pi.cmd"), `@"${nodeBin}" "${piCli}" %*\r\n`);
    return;
  }
  const path = join(binDir, "pi");
  writeFileSync(path, `#!/bin/sh\nexec "${nodeBin}" "${piCli}" "$@"\n`);
  chmodSync(path, 0o755);
}

/**
 * herdr's own config: its first-run tour is skipped (the plugin already set
 * up the workspace), and a non-login shell keeps the private PATH in panes.
 */
export function herdrConfig(shell) {
  const lines = ["# Written by the POM pi harness plugin when missing; edit freely.", "onboarding = false", "", "[terminal]"];
  if (shell) lines.push(`default_shell = ${JSON.stringify(shell)}`);
  lines.push('shell_mode = "non_login"', "");
  return lines.join("\n");
}

function writeHerdrConfig(shell) {
  const path = join(home, ".config", "herdr", "config.toml");
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) writeFileSync(path, herdrConfig(shell));
}

/**
 * Trust the plugin's own working folder in pi once, so the agent starts
 * without the project-trust prompt. A decision already saved for that folder,
 * including "do not trust", is kept.
 */
export function withTrustedFolder(trust, folder) {
  if (trust && Object.hasOwn(trust, folder)) return undefined;
  return { ...(trust ?? {}), [folder]: true };
}

function writePiTrust() {
  const path = join(home, ".pi", "agent", "trust.json");
  mkdirSync(dirname(path), { recursive: true });
  const next = withTrustedFolder(readJson(path, {}), realpathSync(workspace));
  if (next) writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
}

// --- POM models for pi ------------------------------------------------------

async function listPomModels() {
  const headers = { accept: "application/json", authorization: `Bearer ${llmApiKey}` };
  const response = await fetch(`${llmBaseUrl}/models`, { headers, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`GET ${llmBaseUrl}/models returned HTTP ${response.status}`);
  const body = await response.json();
  const rows = Array.isArray(body?.data) ? body.data : [];
  return rows
    .map((row) => (typeof row?.id === "string" ? row.id.trim() : ""))
    .filter((id, index, ids) => id && ids.indexOf(id) === index);
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * pi's `models.json` with the POM provider set to the models the node serves
 * (the key comes from `$POM_API_KEY` in pi's environment, never the file).
 * Other providers the user added are kept. pi rereads the file whenever
 * `/model` opens, so a new POM deployment shows up without a restart.
 */
export function withPomProvider(current, baseUrl, modelIds) {
  const providers = { ...(current?.providers ?? {}) };
  if (modelIds.length === 0) delete providers[PROVIDER];
  else {
    providers[PROVIDER] = {
      baseUrl,
      api: "openai-completions",
      apiKey: "$POM_API_KEY",
      models: modelIds.map((id) => ({ id })),
    };
  }
  return { ...(current ?? {}), providers };
}

/**
 * pi's startup model: set it to the first POM model while the user has not
 * chosen one, or when the saved choice is a POM model no longer served. A
 * choice of another provider is never touched. Returns undefined to keep it.
 */
export function withDefaultModel(settings, modelIds) {
  if (modelIds.length === 0) return undefined;
  const unset = !settings?.defaultProvider && !settings?.defaultModel;
  const stale = settings?.defaultProvider === PROVIDER && !modelIds.includes(settings?.defaultModel);
  if (!unset && !stale) return undefined;
  return { ...(settings ?? {}), defaultProvider: PROVIDER, defaultModel: modelIds[0] };
}

function writePiConfig(modelIds) {
  const agentDir = join(home, ".pi", "agent");
  mkdirSync(agentDir, { recursive: true });
  const modelsPath = join(agentDir, "models.json");
  const models = `${JSON.stringify(withPomProvider(readJson(modelsPath, {}), llmBaseUrl, modelIds), null, 2)}\n`;
  let changed = false;
  if (readFileSafe(modelsPath) !== models) {
    writeFileSync(modelsPath, models);
    changed = true;
  }
  const settingsPath = join(agentDir, "settings.json");
  const settings = withDefaultModel(readJson(settingsPath, {}), modelIds);
  if (settings) {
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    log(`pi default model set to ${PROVIDER}/${settings.defaultModel}`);
  }
  return changed;
}

function readFileSafe(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function followPomModels(initial) {
  let known = JSON.stringify(initial);
  const timer = setInterval(async () => {
    let modelIds;
    try {
      modelIds = await listPomModels();
    } catch (error) {
      log(`POM models unavailable: ${error.message}`);
      return;
    }
    const ids = JSON.stringify(modelIds);
    if (ids === known) return;
    known = ids;
    if (writePiConfig(modelIds)) log(`POM models changed: ${ids}`);
  }, MODEL_POLL_MS);
  timer.unref();
}

// --- herdr ------------------------------------------------------------------

function herdr(runEnv, args) {
  return new Promise((resolve, reject) => {
    execFile(herdrBin, args, { env: runEnv, cwd: home, timeout: 60_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`herdr ${args.join(" ")}: ${stderr.trim() || error.message}`));
      else resolve(stdout);
    });
  });
}

async function herdrJson(runEnv, args) {
  const reply = JSON.parse(await herdr(runEnv, args));
  if (reply.error) throw new Error(`herdr ${args.join(" ")}: ${reply.error.message}`);
  return reply.result;
}

function startHerdrServer(runEnv) {
  server = spawn(herdrBin, ["server"], { env: runEnv, cwd: home, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", (chunk) => process.stderr.write(chunk));
  server.stderr.on("data", (chunk) => process.stderr.write(chunk));
  server.on("exit", (code, signal) => {
    log(`herdr server exited (code ${code}, signal ${signal})`);
    if (reported) shutdown(code ?? 1);
  });
}

async function waitForServer(runEnv) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const status = await herdr(runEnv, ["status", "server"]);
      if (/status:\s*running/.test(status)) return;
    } catch {
      // not listening yet
    }
    if (server.exitCode !== null) throw new Error("herdr server stopped while starting");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("herdr server did not start");
}

/** A "POM" workspace with a pi agent, created once; herdr restores it afterwards. */
async function ensurePiWorkspace(runEnv) {
  const listed = await herdrJson(runEnv, ["workspace", "list"]);
  if ((listed.workspaces ?? []).length > 0) return;
  const created = await herdrJson(runEnv, ["workspace", "create", "--cwd", workspace, "--label", "POM", "--focus"]);
  const pane = created.root_pane.pane_id;
  await herdrJson(runEnv, ["agent", "start", "pi", "--kind", "pi", "--pane", pane, "--timeout", "60000"]);
  log(`started pi in herdr pane ${pane}`);
}

// --- Terminal endpoint -------------------------------------------------------

function tokenMatches(candidate) {
  if (typeof candidate !== "string") return false;
  const expected = Buffer.from(token);
  const actual = Buffer.from(candidate);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Terminal size from the attach URL, clamped to what a screen can show. */
export function terminalSize(rawUrl) {
  const url = new URL(rawUrl, "http://terminal.invalid");
  const clamp = (value, fallback, max) => {
    const number = Number.parseInt(value ?? "", 10);
    return Number.isFinite(number) && number >= 10 ? Math.min(number, max) : fallback;
  };
  return { cols: clamp(url.searchParams.get("cols"), 120, 500), rows: clamp(url.searchParams.get("rows"), 32, 300) };
}

/**
 * Browser messages: binary or text frames are keystrokes; a text frame that is
 * a JSON object with `type: "resize"` resizes the terminal.
 */
export function parseClientMessage(data, isBinary) {
  if (isBinary) return { type: "input", data: Buffer.from(data).toString("utf8") };
  const text = data.toString();
  if (text.startsWith("{")) {
    try {
      const message = JSON.parse(text);
      if (message?.type === "resize") {
        const cols = Math.trunc(Number(message.cols));
        const rows = Math.trunc(Number(message.rows));
        if (cols >= 10 && rows >= 5 && cols <= 500 && rows <= 300) return { type: "resize", cols, rows };
        return { type: "ignore" };
      }
    } catch {
      // not a control message: plain input that starts with "{"
    }
  }
  return { type: "input", data: text };
}

function startTerminalServer(runEnv) {
  const pty = require("node-pty");
  const { WebSocketServer } = require("ws");
  const sockets = new WebSocketServer({ noServer: true });
  const httpServer = http.createServer((request, response) => {
    if (!tokenMatches(request.headers[TOKEN_HEADER])) {
      response.writeHead(401, { "content-type": "text/plain" }).end("missing or invalid plugin token");
      return;
    }
    if (new URL(request.url, "http://terminal.invalid").pathname === "/health") {
      response.writeHead(200, { "content-type": "application/json" }).end('{"status":"ready"}');
      return;
    }
    response.writeHead(404).end();
  });

  httpServer.on("upgrade", (request, socket, head) => {
    const path = new URL(request.url, "http://terminal.invalid").pathname;
    if (!tokenMatches(request.headers[TOKEN_HEADER]) || path !== "/terminal") {
      socket.end("HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n");
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) => {
      const { cols, rows } = terminalSize(request.url);
      // One herdr client per browser tab; closing it only detaches.
      const term = pty.spawn(herdrBin, [], { name: "xterm-256color", cols, rows, cwd: home, env: runEnv });
      term.onData((data) => {
        if (ws.readyState === ws.OPEN) ws.send(data);
      });
      term.onExit(() => ws.close(1000, "terminal closed"));
      ws.on("message", (data, isBinary) => {
        const message = parseClientMessage(data, isBinary);
        if (message.type === "input") term.write(message.data);
        else if (message.type === "resize") term.resize(message.cols, message.rows);
      });
      ws.on("close", () => term.kill());
      ws.on("error", () => term.kill());
    });
  });

  return new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => resolve(httpServer.address().port));
  });
}

// --- Main -------------------------------------------------------------------

async function main() {
  if (!llmBaseUrl || !llmApiKey) throw new Error("the POM did not provide PI_POM_LLM_BASE_URL and PI_POM_LLM_API_KEY");
  for (const directory of [dataDir, home, workspace]) mkdirSync(directory, { recursive: true });
  const socket = socketPath(home);
  if (socket) mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
  const shell = pickShell();
  const runEnv = privateEnv({ base: env, home, binDir, herdrBin, shell, apiKey: llmApiKey, socket });
  writePiWrapper();
  writeHerdrConfig(shell);
  writePiTrust();

  let modelIds = [];
  let warning;
  try {
    modelIds = await listPomModels();
    if (modelIds.length === 0) warning = `${llmBaseUrl}/models listed no models yet`;
  } catch (error) {
    warning = `POM models unavailable: ${error.message}`;
  }
  if (warning) log(warning);
  writePiConfig(modelIds);

  // herdr's pi integration reports exact agent state (working, blocked, idle);
  // it installs into pi's private agent directory and is idempotent.
  await herdr(runEnv, ["integration", "install", "pi"]).catch((error) => log(error.message));
  startHerdrServer(runEnv);
  await waitForServer(runEnv);
  await ensurePiWorkspace(runEnv).catch((error) => {
    warning = [warning, error.message].filter(Boolean).join("; ");
    log(error.message);
  });
  const port = await startTerminalServer(runEnv);
  followPomModels(modelIds);
  log(`terminal on 127.0.0.1:${port}; herdr socket ${socket ?? "default"}; ${modelIds.length} POM model(s)`);
  report({ status: "ready", port, token, models: modelIds, warning });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdin.on("end", () => shutdown(0));
  process.stdin.on("error", () => shutdown(0));
  process.stdin.resume();
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => shutdown(0));
  main().catch(fail);
}
