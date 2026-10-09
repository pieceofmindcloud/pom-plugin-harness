// Supervisor of herdr and a pi coding agent inside the POM plugin.
//
// The plugin library starts this script with the Node runtime shipped next to
// it, passing the model endpoint and API key the POM handed over
// (`HARNESS_POM_LLM_BASE_URL`, `HARNESS_POM_LLM_API_KEY`). It:
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
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unwatchFile, watchFile, writeFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import path, { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  AGENTS,
  configureAgents,
  detectHostAgents,
  fccPort,
  installAgents,
  normalizeChoice,
  parsePomModels,
  preferredModel,
  superviseFcc,
  trustHerdrCodexHooks,
  withOutputCeiling,
} from "./agents.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "app", "package.json"));
const env = process.env;
const isWindows = process.platform === "win32";
const dataDir = env.HARNESS_POM_DATA_DIR || join(here, "data");
const home = join(dataDir, "home");
const binDir = join(dataDir, "bin");
const llmBaseUrl = (env.HARNESS_POM_LLM_BASE_URL || "").replace(/\/+$/, "");
const llmApiKey = env.HARNESS_POM_LLM_API_KEY || "";
const workspaceRoot = env.HARNESS_POM_WORKSPACE_ROOT || "";
/**
 * Where pi and every agent start: the POM's shared projects workspace (Storage
 * settings, `workspace_root` in host.configure), the same folder every harness
 * plugin works in. Only a POM without one falls back to a plugin-private folder.
 */
const workspace = workspaceRoot || join(dataDir, "workspace");
const herdrBin = join(here, "bin", isWindows ? "herdr.exe" : "herdr");
const nodeBin = process.execPath;
const piCli = join(here, "app", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
const TOKEN_HEADER = "x-pom-plugin-token";
const MODEL_POLL_MS = Number(env.HARNESS_POM_MODEL_POLL_MS || 15_000);
const PROVIDER = "pom";
const token = randomBytes(32).toString("base64url");
// FCC reaches the POM through the launcher at this secret path (it has no key setting).
const relaySecret = randomBytes(24).toString("base64url");
const agentsManifestPath = join(here, "agents.json");
const npmCli = join(here, "npm", "bin", "npm-cli.js");
// The POM models with their limits, for the agent shim (`agent-shim.mjs`).
const pomModelsPath = join(dataDir, "pom-models.json");

let server;
let reported = false;
let stopAgents = () => {};
// The POM models as last listed, with their limits.
let currentModels = [];

function log(message) {
  process.stderr.write(`harness: ${message}\n`);
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
  stopAgents();
  if (server && server.exitCode === null) server.kill("SIGTERM");
  setTimeout(() => process.exit(code), 300).unref();
}

// --- Private environment ----------------------------------------------------

/**
 * Unix socket paths are limited to about 104 bytes on macOS. Keep herdr's
 * socket under the plugin data directory when it fits, else in a private
 * directory under the system temp dir named after that data directory.
 */
export function socketPath(homeDir, tempDir = tmpdir(), platform = process.platform) {
  if (platform === "win32") return undefined;
  const preferred = path.posix.join(homeDir, "herdr.sock");
  if (Buffer.byteLength(preferred) <= 90) return preferred;
  const id = createHash("sha256").update(homeDir).digest("hex").slice(0, 16);
  return path.posix.join(tempDir, `pom-harness-${id}`, "herdr.sock");
}

/**
 * The only environment herdr, its panes and pi ever see. Nothing is copied
 * from the POM process but the few variables a shell needs, so a `HERDR_*`
 * or provider key of the host never leaks in.
 */
export function privateEnv(options) {
  const platform = options.platform ?? process.platform;
  const windows = platform === "win32";
  const paths = windows ? path.win32 : path.posix;
  const keep = ["LANG", "LC_ALL", "LC_CTYPE", "TZ", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP"];
  const result = {};
  for (const name of keep) if (options.base[name] !== undefined) result[name] = options.base[name];
  const systemRoot = options.base.SYSTEMROOT ?? options.base.SystemRoot ?? "C:\\Windows";
  const system = windows
    ? [paths.join(systemRoot, "System32"), systemRoot, paths.join(systemRoot, "System32", "WindowsPowerShell", "v1.0")]
    : ["/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  // herdr reads %APPDATA%\herdr on Windows and ~/.config/herdr elsewhere.
  const appData = paths.join(options.home, "AppData", "Roaming");
  const configDir = windows ? paths.join(appData, "herdr") : paths.join(options.home, ".config", "herdr");
  Object.assign(result, {
    HOME: options.home,
    USERPROFILE: options.home,
    PATH: [options.binDir, paths.dirname(options.herdrBin), ...system].join(windows ? ";" : ":"),
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    HERDR_CONFIG_PATH: paths.join(configDir, "config.toml"),
    PI_CODING_AGENT_DIR: paths.join(options.home, ".pi", "agent"),
    POM_API_KEY: options.apiKey,
  });
  if (windows) {
    result.APPDATA = appData;
    result.LOCALAPPDATA = paths.join(options.home, "AppData", "Local");
  } else {
    result.SHELL = options.shell;
    // macOS bash otherwise greets every new pane with its zsh migration notice.
    result.BASH_SILENCE_DEPRECATION_WARNING = "1";
  }
  if (options.socket) result.HERDR_SOCKET_PATH = options.socket;
  return result;
}

function pickShell() {
  if (isWindows) return join(binDir, "pom-shell.cmd");
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
 * The pane shell on Windows. herdr's terminal library rebuilds each pane's
 * environment from the registry, so PATH comes back as the machine's own and
 * `pi`, `pom-agents` and the agents are "not recognized". This wrapper puts the
 * private directories back in front before handing the pane to PowerShell.
 */
export function windowsPaneShell(prefix) {
  return `@echo off\r\nset "PATH=${prefix.join(";")};%PATH%"\r\npowershell.exe -NoLogo\r\n`;
}

function writeWindowsPaneShell(shell, runEnv) {
  if (!isWindows) return;
  const prefix = runEnv.PATH.split(";").slice(0, 2);
  writeFileSync(shell, windowsPaneShell(prefix));
}

/**
 * herdr's own config: its first-run tour is skipped (the plugin already set
 * up the workspace), and a non-login shell keeps the private PATH in panes.
 */
export function herdrConfig(shell) {
  const lines = ["# Written by the POM harness plugin when missing; edit freely.", "onboarding = false", "", "[terminal]"];
  if (shell) lines.push(`default_shell = ${JSON.stringify(shell)}`);
  lines.push('shell_mode = "non_login"', "");
  return lines.join("\n");
}

/**
 * A config written before the plugin chose the shell gets `default_shell`
 * under `[terminal]`; one that already names a shell is left alone.
 */
export function withDefaultShell(config, shell) {
  if (!shell || /^\s*default_shell\s*=/m.test(config)) return undefined;
  const line = `default_shell = ${JSON.stringify(shell)}`;
  if (/^\[terminal\]\s*$/m.test(config)) return config.replace(/^\[terminal\]\s*$/m, (header) => `${header}\n${line}`);
  return `${config.replace(/\n*$/, "\n")}\n[terminal]\n${line}\n`;
}

function writeHerdrConfig(configPath, shell) {
  mkdirSync(dirname(configPath), { recursive: true });
  if (!existsSync(configPath)) {
    writeFileSync(configPath, herdrConfig(shell));
    return;
  }
  const updated = withDefaultShell(readFileSync(configPath, "utf8"), shell);
  if (updated) writeFileSync(configPath, updated);
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
  return parsePomModels(await response.json());
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
export function withPomProvider(current, baseUrl, models) {
  const providers = { ...(current?.providers ?? {}) };
  if (models.length === 0) delete providers[PROVIDER];
  else {
    providers[PROVIDER] = {
      baseUrl,
      api: "openai-completions",
      apiKey: "$POM_API_KEY",
      // The POM's limits per model; without them pi assumes 128000 and 16384.
      models: models.map(({ id, contextWindow, maxTokens }) => ({
        id,
        ...(contextWindow && { contextWindow }),
        ...(maxTokens && { maxTokens }),
      })),
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
  return { ...(settings ?? {}), defaultProvider: PROVIDER, defaultModel: preferredModel(modelIds) };
}

function writePiConfig(models) {
  const modelIds = models.map((model) => model.id);
  const agentDir = join(home, ".pi", "agent");
  mkdirSync(agentDir, { recursive: true });
  const modelsPath = join(agentDir, "models.json");
  const text = `${JSON.stringify(withPomProvider(readJson(modelsPath, {}), llmBaseUrl, models), null, 2)}\n`;
  let changed = false;
  if (readFileSafe(modelsPath) !== text) {
    writeFileSync(modelsPath, text);
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

/** The POM models for the agent shim, which runs later in a herdr pane. */
function writePomModels(models) {
  currentModels = models;
  writeFileSync(pomModelsPath, `${JSON.stringify(models, null, 2)}\n`);
}

function describeModels(models) {
  return models.map(({ id, contextWindow, maxTokens }) => `${id} (context ${contextWindow ?? "?"}, output ${maxTokens ?? "?"})`).join(", ");
}

function followPomModels(initial, onChange) {
  // Limits count as a change too: a deployment publishes them once its capacity is confirmed.
  let known = JSON.stringify(initial);
  const timer = setInterval(async () => {
    let models;
    try {
      models = await listPomModels();
    } catch (error) {
      log(`POM models unavailable: ${error.message}`);
      return;
    }
    const current = JSON.stringify(models);
    if (current === known) return;
    known = current;
    writePomModels(models);
    if (writePiConfig(models)) log(`POM models changed: ${describeModels(models)}`);
    onChange(models);
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

/** Whether a workspace whose panes run in `cwd` must be made again in `target`. */
export function workspaceMoved(cwd, target) {
  return Boolean(cwd) && Boolean(target) && resolve(cwd) !== resolve(target);
}

/** The folder the panes of a workspace run in (its first pane's), or null. */
async function workspaceCwd(runEnv, workspaceId) {
  const listed = await herdrJson(runEnv, ["pane", "list"]);
  return (listed.panes ?? []).find((pane) => pane.workspace_id === workspaceId)?.cwd ?? null;
}

/**
 * A "POM" workspace with a pi agent, created once; herdr restores it afterwards.
 * herdr cannot move a workspace, so one restored in another folder than the
 * POM's shared workspace (made before the POM named that folder, or before it
 * changed) is closed and made again where the POM says, and the agent tabs
 * open again in it. The files of the old folder stay where they are.
 */
async function ensurePiWorkspace(runEnv) {
  const listed = await herdrJson(runEnv, ["workspace", "list"]);
  const existing = listed.workspaces ?? [];
  if (existing.length > 0) {
    const pom = existing.find((entry) => entry.label === "POM") ?? existing[0];
    const cwd = await workspaceCwd(runEnv, pom.workspace_id);
    if (!workspaceMoved(cwd, workspace)) return;
    log(`the POM workspace runs in ${cwd}, not in ${workspace}: making it again there`);
    await herdrJson(runEnv, ["workspace", "close", pom.workspace_id]);
    rmSync(join(dataDir, "agents-tabs.json"), { force: true });
  }
  mkdirSync(workspace, { recursive: true });
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

/**
 * FCC's `llamacpp` provider sends a fixed placeholder key, so it reaches the
 * POM through this loopback relay at a per-launch secret path, which swaps in
 * the POM key. Paths below `<secret>/v1` map onto the POM `/v1`.
 */
export function relayTarget(rawUrl, secret, baseUrl) {
  const prefix = `/relay/${secret}/v1`;
  if (!rawUrl.startsWith(prefix)) return undefined;
  return `${baseUrl}${rawUrl.slice(prefix.length)}`;
}

function relayToPom(request, response) {
  const target = relayTarget(request.url, relaySecret, llmBaseUrl);
  if (!target) {
    response.writeHead(404).end();
    return;
  }
  const url = new URL(target);
  const headers = { ...request.headers, host: url.host, authorization: `Bearer ${llmApiKey}` };
  delete headers["x-api-key"];
  if (request.method === "POST" && url.pathname.endsWith("/chat/completions")) {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      let body = Buffer.concat(chunks);
      try {
        const patched = withOutputCeiling(JSON.parse(body.toString("utf8")), currentModels);
        if (patched) body = Buffer.from(JSON.stringify(patched));
      } catch {
        // Not JSON: the POM answers it as it is.
      }
      delete headers["transfer-encoding"];
      headers["content-length"] = String(body.length);
      forwardToPom(request, response, url, headers).end(body);
    });
    return;
  }
  request.pipe(forwardToPom(request, response, url, headers));
}

function forwardToPom(request, response, url, headers) {
  const outbound = http.request(
    { host: url.hostname, port: url.port || 80, method: request.method, path: `${url.pathname}${url.search}`, headers },
    (reply) => {
      response.writeHead(reply.statusCode, reply.headers);
      reply.pipe(response);
    },
  );
  outbound.on("error", (error) => {
    log(`relay ${request.method} ${url.pathname}: ${error.message}`);
    if (!response.headersSent) response.writeHead(502);
    response.end();
  });
  return outbound;
}

export function listWorkspaceProjects(root) {
  if (!root) return { status: "unavailable", projects: [] };
  try {
    const projects = readdirSync(root, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith(".") && entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
    return projects.length ? { status: "ready", projects } : { status: "empty", projects: [] };
  } catch {
    return { status: "unavailable", projects: [] };
  }
}

function startTerminalServer(runEnv) {
  const pty = require("node-pty");
  const { WebSocketServer } = require("ws");
  const sockets = new WebSocketServer({ noServer: true });
  const httpServer = http.createServer((request, response) => {
    if (request.url.startsWith(`/relay/${relaySecret}/`)) {
      relayToPom(request, response);
      return;
    }
    if (!tokenMatches(request.headers[TOKEN_HEADER])) {
      response.writeHead(401, { "content-type": "text/plain" }).end("missing or invalid plugin token");
      return;
    }
    const pathname = new URL(request.url, "http://terminal.invalid").pathname;
    if (pathname === "/health") {
      response.writeHead(200, { "content-type": "application/json" }).end('{"status":"ready"}');
      return;
    }
    if (request.method === "GET" && pathname === "/projects") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(listWorkspaceProjects(workspaceRoot)));
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
      // The ConPTY bundled with node-pty: the one in Windows drops part of the
      // browser's mouse reports, so herdr's tabs and agents did not take clicks.
      const term = pty.spawn(herdrBin, [], { name: "xterm-256color", cols, rows, cwd: home, env: runEnv, useConptyDll: isWindows });
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

// --- Other agents (chosen on first use) --------------------------------------

const agentsDetectedPath = join(dataDir, "agents-detected.json");
const agentsChoicePath = join(dataDir, "agents-choice.json");
const agentsStatusPath = join(dataDir, "agents-status.json");

async function pomWorkspace(runEnv) {
  const listed = await herdrJson(runEnv, ["workspace", "list"]);
  return (listed.workspaces ?? []).find((entry) => entry.label === "POM") ?? listed.workspaces?.[0];
}

/** pi's tab carries herdr's numbered default label until it is named like the agent tabs. */
async function namePiTab(runEnv) {
  const pom = await pomWorkspace(runEnv);
  if (!pom) return;
  const tabs = await herdrJson(runEnv, ["tab", "list"]);
  const piTab = (tabs.tabs ?? []).find((entry) => entry.workspace_id === pom.workspace_id && entry.number === 1);
  if (piTab?.label === "1") await herdrJson(runEnv, ["tab", "rename", piTab.tab_id, "pi"]);
}

/** One tab per chosen agent in the POM workspace, each opened once; herdr restores them afterwards. */
async function openAgentTabs(runEnv, kinds) {
  const statePath = join(dataDir, "agents-tabs.json");
  const opened = new Set(readJson(statePath, {}).opened ?? []);
  const missing = AGENTS.filter((agent) => kinds.includes(agent.kind) && !opened.has(agent.kind));
  if (missing.length === 0) return;
  const pom = await pomWorkspace(runEnv);
  if (!pom) return;
  for (const agent of missing) {
    const tab = await herdrJson(runEnv, [
      "tab", "create", "--workspace", pom.workspace_id, "--cwd", workspace, "--label", agent.label, "--no-focus",
    ]);
    await herdrJson(runEnv, [
      "agent", "start", agent.kind, "--kind", agent.kind, "--pane", tab.root_pane.pane_id, "--timeout", "60000",
    ]).catch((error) => log(error.message));
    opened.add(agent.kind);
    writeFileSync(statePath, `${JSON.stringify({ opened: [...opened] })}\n`);
  }
}

async function closeLegacySetupTabs(runEnv) {
  const pom = await pomWorkspace(runEnv);
  if (!pom) return;
  const listed = await herdrJson(runEnv, ["tab", "list"]);
  for (const tab of listed.tabs ?? []) {
    if (tab.workspace_id === pom.workspace_id && tab.label === "Setup") {
      await herdr(runEnv, ["tab", "close", tab.tab_id]).catch((error) => log(error.message));
    }
  }
}

/** `pom-agents` on the panes' PATH lets the user adjust the automatic default. */
function writeSetupCommand() {
  const setup = join(here, "agent-setup.mjs");
  if (isWindows) {
    writeFileSync(join(binDir, "pom-agents.cmd"), `@"${nodeBin}" "${setup}" "${dataDir}" %*\r\n`);
    return;
  }
  const path = join(binDir, "pom-agents");
  writeFileSync(path, `#!/bin/sh\nexec "${nodeBin}" "${setup}" "${dataDir}" "$@"\n`);
  chmodSync(path, 0o755);
}

function writeAgentsStatus(savedAt, state, message) {
  writeFileSync(agentsStatusPath, `${JSON.stringify({ savedAt, state, message })}\n`);
}

/**
 * Claude Code, Codex and opencode next to pi. On first use all are selected
 * automatically: working host installs are reused, missing ones are bundled
 * from the pinned releases. `pom-agents` remains available for later changes.
 */
async function startAgents(runEnv, terminalPort, models) {
  const manifest = readJson(agentsManifestPath, undefined);
  if (!manifest) {
    log("no agents manifest in this build; only pi is available");
    return undefined;
  }
  const detected = await detectHostAgents({
    platform: process.platform,
    home: homedir(),
    pathEnv: env.PATH,
    nodeBin,
    exclude: [dataDir, here],
    baseEnv: env,
  });
  const found = Object.entries(detected).map(([kind, host]) => `${kind} ${host.version} (${host.path})`);
  log(found.length > 0 ? `already on this machine: ${found.join(", ")}` : "no agent installed on this machine");
  writeFileSync(agentsDetectedPath, `${JSON.stringify({ detected, versions: manifest.npm, home: homedir() }, null, 2)}\n`);
  writeSetupCommand();
  await closeLegacySetupTabs(runEnv).catch((error) => log(`old setup tab: ${error.message}`));
  const existingChoice = readJson(agentsChoicePath, undefined);
  if (!existingChoice || typeof existingChoice.savedAt !== "string") {
    const savedAt = new Date().toISOString();
    const choice = normalizeChoice(undefined, detected);
    writeFileSync(`${agentsChoicePath}.tmp`, `${JSON.stringify({ savedAt, agents: choice.agents }, null, 2)}\n`);
    renameSync(`${agentsChoicePath}.tmp`, agentsChoicePath);
    log("selecting Claude Code, Codex and opencode automatically");
  }

  const context = {
    home,
    workspace: realpathSync(workspace),
    llmBaseUrl,
    relayUrl: `http://127.0.0.1:${terminalPort}/relay/${relaySecret}/v1`,
    fccPort: await fccPort(home),
    token: randomBytes(32).toString("base64url"),
  };
  let latestModels = models;
  let fcc;
  let applied;
  let queue = Promise.resolve();

  const apply = async () => {
    const saved = readJson(agentsChoicePath, undefined);
    if (!saved || saved.savedAt === applied) return;
    applied = saved.savedAt;
    const choice = normalizeChoice(saved, detected);
    const kinds = AGENTS.filter((agent) => choice.agents[agent.kind].enabled).map((agent) => agent.kind);
    try {
      writeAgentsStatus(saved.savedAt, "installing", "Installing (the first time takes about a minute)...");
      const { fccBin, exe } = await installAgents({
        manifest,
        choice,
        dataDir,
        runEnv,
        nodeBin,
        npmCli,
        binDir,
        shim: join(here, "agent-shim.mjs"),
        modelsPath: pomModelsPath,
        windows: isWindows,
        log: (message) => {
          log(message);
          writeAgentsStatus(saved.savedAt, "installing", `${message[0].toUpperCase()}${message.slice(1)}...`);
        },
      });
      configureAgents({ ...context, models: latestModels });
      for (const kind of kinds) {
        await herdr(runEnv, ["integration", "install", kind]).catch((error) => log(error.message));
      }
      // Codex asks to review new hooks on start; herdr's state hook is ours.
      trustHerdrCodexHooks(home);
      if (fccBin && !fcc) fcc = superviseFcc({ fccBin, exe, runEnv, home, log });
      if (!fccBin && fcc) {
        fcc.stop();
        fcc = undefined;
      }
      writeAgentsStatus(saved.savedAt, "installing", "Opening a tab for each agent...");
      await openAgentTabs(runEnv, kinds);
      const labels = AGENTS.filter((agent) => kinds.includes(agent.kind)).map((agent) => agent.label);
      log(labels.length > 0 ? `${labels.join(", ")} ready${fcc ? ` (FCC on 127.0.0.1:${context.fccPort})` : ""}` : "only pi chosen");
      writeAgentsStatus(saved.savedAt, "ready", labels.length > 0 ? `Ready: ${labels.join(", ")}.` : "Done.");
    } catch (error) {
      log(`agents unavailable: ${error.message}`);
      writeAgentsStatus(saved.savedAt, "error", `Could not set up the agents: ${error.message}`);
    }
  };
  const schedule = () => {
    queue = queue.then(apply);
  };
  watchFile(agentsChoicePath, { interval: 1000 }, schedule);
  if (existsSync(agentsChoicePath)) schedule();

  return {
    modelsChanged(nextModels) {
      latestModels = nextModels;
      queue = queue.then(() => {
        if (configureAgents({ ...context, models: nextModels })) fcc?.restart();
      });
    },
    stop() {
      unwatchFile(agentsChoicePath);
      fcc?.stop();
    },
  };
}

// --- Main -------------------------------------------------------------------

async function main() {
  if (!llmBaseUrl || !llmApiKey) throw new Error("the POM did not provide HARNESS_POM_LLM_BASE_URL and HARNESS_POM_LLM_API_KEY");
  for (const directory of [dataDir, home, workspace]) mkdirSync(directory, { recursive: true });
  const socket = socketPath(home);
  if (socket) mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
  const shell = pickShell();
  const runEnv = privateEnv({ base: env, home, binDir, herdrBin, shell, apiKey: llmApiKey, socket });
  writePiWrapper();
  writeWindowsPaneShell(shell, runEnv);
  if (runEnv.LOCALAPPDATA) mkdirSync(runEnv.LOCALAPPDATA, { recursive: true });
  writeHerdrConfig(runEnv.HERDR_CONFIG_PATH, shell);
  writePiTrust();

  let models = [];
  let warning;
  try {
    models = await listPomModels();
    if (models.length === 0) warning = `${llmBaseUrl}/models listed no models yet`;
  } catch (error) {
    warning = `POM models unavailable: ${error.message}`;
  }
  if (warning) log(warning);
  writePomModels(models);
  writePiConfig(models);
  if (models.length > 0) log(`POM models: ${describeModels(models)}`);

  // herdr's pi integration reports exact agent state (working, blocked, idle);
  // it installs into pi's private agent directory and is idempotent.
  await herdr(runEnv, ["integration", "install", "pi"]).catch((error) => log(error.message));
  startHerdrServer(runEnv);
  await waitForServer(runEnv);
  await ensurePiWorkspace(runEnv).catch((error) => {
    warning = [warning, error.message].filter(Boolean).join("; ");
    log(error.message);
  });
  await namePiTab(runEnv).catch((error) => log(error.message));
  const port = await startTerminalServer(runEnv);
  let agents;
  startAgents(runEnv, port, models)
    .then((started) => {
      agents = started;
      stopAgents = () => started?.stop();
    })
    .catch((error) => log(`other agents unavailable: ${error.message}`));
  followPomModels(models, (next) => agents?.modelsChanged(next));
  log(`terminal on 127.0.0.1:${port}; herdr socket ${socket ?? "default"}; ${models.length} POM model(s)`);
  report({ status: "ready", port, token, models: models.map((model) => model.id), warning });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdin.on("end", () => shutdown(0));
  process.stdin.on("error", () => shutdown(0));
  process.stdin.resume();
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => shutdown(0));
  main().catch(fail);
}
