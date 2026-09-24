// Claude Code, Codex and opencode next to pi, installed on first use.
//
// The build pins every version in `agents.json` (npm packages, the uv release
// with its SHA-256, and a free-claude-code commit); this module installs them
// under the plugin data directory the first time and keeps them wired to the
// POM:
//
// - opencode speaks OpenAI Chat Completions, so it talks to the POM directly
//   through a `pom` provider in its config;
// - Claude Code (Anthropic Messages) and Codex (OpenAI Responses) go through
//   free-claude-code (FCC), a local proxy that translates both to Chat
//   Completions. FCC's `llamacpp` provider points at a relay in the launcher
//   that adds the POM key, since that provider has no key setting.
//
// Only the entries the plugin owns are written: the `pom` provider, FCC's
// connection keys, and defaults while the user has none. Everything else a
// user configures in these agents is left alone.

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import path, { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const PROVIDER = "pom";
/** FCC keys the plugin owns in `~/.fcc/.env`; everything else there is the user's. */
export const FCC_OWNED_KEYS = ["HOST", "PORT", "PROXY_AUTH_ENABLED", "LLAMACPP_BASE_URL"];

/** The agents offered next to pi, in tab order, with the npm package of each. */
export const AGENTS = [
  { kind: "claude", label: "Claude Code", npm: "@anthropic-ai/claude-code", viaFcc: true },
  { kind: "codex", label: "Codex", npm: "@openai/codex", viaFcc: true },
  { kind: "opencode", label: "opencode", npm: "opencode-ai", viaFcc: false },
];

// --- Pure configuration helpers (unit tested) ------------------------------

/**
 * Which agents to run and where each comes from, as saved by the setup screen:
 * `{ agents: { <kind>: { enabled, source: "bundled" | "host", path? } } }`.
 * Anything missing or malformed falls back to the default: every agent on,
 * from the machine when it is installed there, else the pinned release.
 */
export function normalizeChoice(raw, detected) {
  const agents = {};
  for (const { kind } of AGENTS) {
    const saved = raw?.agents?.[kind];
    const host = detected?.[kind];
    const enabled = typeof saved?.enabled === "boolean" ? saved.enabled : true;
    const useHost = saved?.source === "host" ? Boolean(host) : saved?.source === "bundled" ? false : Boolean(host);
    agents[kind] = useHost ? { enabled, source: "host", path: host.path } : { enabled, source: "bundled" };
  }
  return { agents };
}

/** What the choice needs installed: the npm packages of bundled agents, and FCC for Claude Code or Codex. */
export function installPlan(manifest, choice) {
  const npm = {};
  let fcc = false;
  for (const agent of AGENTS) {
    const chosen = choice.agents[agent.kind];
    if (!chosen?.enabled) continue;
    if (agent.viaFcc) fcc = true;
    if (chosen.source === "bundled") npm[agent.npm] = manifest.npm[agent.npm];
  }
  return { npm, fcc };
}

/**
 * The model new sessions should start on. The POM lists each deployment twice:
 * a stable name and a `name@d-<deployment>` alias that changes on every
 * redeploy, so the stable name is preferred.
 */
export function preferredModel(modelIds) {
  return modelIds.find((id) => !id.includes("@")) ?? modelIds[0];
}

/**
 * The POM's `/v1/models` rows as `{ id, contextWindow?, maxTokens? }`. The node
 * publishes each deployment's effective context (`context_length`, also as
 * `max_input_tokens`) and the output ceiling of one request (`max_tokens`);
 * both are absent while the deployment's capacity is still being confirmed.
 */
export function parsePomModels(body) {
  const rows = Array.isArray(body?.data) ? body.data : [];
  const models = [];
  for (const row of rows) {
    const id = typeof row?.id === "string" ? row.id.trim() : "";
    if (!id || models.some((model) => model.id === id)) continue;
    const contextWindow = positiveInt(row.context_length ?? row.max_input_tokens ?? row.top_provider?.context_length);
    const maxTokens = positiveInt(row.max_tokens ?? row.top_provider?.max_completion_tokens);
    models.push({ id, ...(contextWindow && { contextWindow }), ...(maxTokens && { maxTokens }) });
  }
  return models;
}

function positiveInt(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** The POM model FCC routes to, from its `MODEL` (`llamacpp/<id>`), when it is one. */
function fccPomModel(fccEnv, models) {
  const model = dotenvValue(fccEnv, "MODEL") ?? "";
  return model.startsWith("llamacpp/") ? models.find((entry) => entry.id === model.slice(9)) : undefined;
}

/**
 * Claude Code's limits for the POM model FCC routes to. FCC sets a 190000
 * auto-compact window for every model and Claude Code asks for its own output
 * size (up to 128000); a smaller POM context must be named here, or the
 * conversation overflows before Claude Code compacts it.
 */
export function claudeLimitsEnv(fccEnv, models) {
  const model = fccPomModel(fccEnv, models);
  const env = {};
  if (model?.contextWindow) env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(model.contextWindow);
  if (model?.maxTokens) env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(model.maxTokens);
  return env;
}

/**
 * FCC's Codex model catalog with each POM model's context window. FCC's
 * llama.cpp provider reads no limits and falls back to 200000 for all.
 */
export function withPomContextWindows(catalog, models) {
  if (!Array.isArray(catalog?.models)) return undefined;
  let changed = false;
  const entries = catalog.models.map((entry) => {
    const slug = typeof entry?.slug === "string" ? entry.slug : "";
    const pom = slug.startsWith("llamacpp/") ? models.find((model) => model.id === slug.slice(9)) : undefined;
    if (!pom?.contextWindow) return entry;
    changed = true;
    return { ...entry, context_window: pom.contextWindow, max_context_window: pom.contextWindow };
  });
  return changed ? { ...catalog, models: entries } : undefined;
}

/**
 * A Chat Completions body FCC relays, with the model's output ceiling when it
 * names none. Codex's requests carry no limit (OpenAI reads that as "up to the
 * model's maximum"), but the POM answers such a request with 512 tokens.
 * Returns undefined to relay the body unchanged.
 */
export function withOutputCeiling(body, models) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  if (body.max_tokens != null || body.max_completion_tokens != null) return undefined;
  const maxTokens = models.find((model) => model.id === body.model)?.maxTokens;
  return maxTokens ? { ...body, max_tokens: maxTokens } : undefined;
}

/** Parse the dotenv lines FCC writes: `KEY=value`, comments and blanks kept verbatim. */
function parseDotenvLines(text) {
  return (text ?? "").split(/\r?\n/).map((line) => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    return match ? { key: match[1], raw: line } : { raw: line };
  });
}

function dotenvValue(text, key) {
  for (const line of parseDotenvLines(text)) {
    if (line.key === key) return line.raw.slice(line.raw.indexOf("=") + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  return undefined;
}

/**
 * FCC's managed dotenv with the plugin's keys set and every other line kept.
 * `MODEL` is only set while unset, or while it names a POM model
 * (`llamacpp/...`) the node no longer serves. The proxy token is created once.
 */
export function withFccSettings(text, owned, modelIds, token) {
  const values = { ...owned };
  const model = dotenvValue(text, "MODEL");
  const served = new Set(modelIds.map((id) => `llamacpp/${id}`));
  if (modelIds.length > 0 && (!model || (model.startsWith("llamacpp/") && !served.has(model)))) {
    values.MODEL = `llamacpp/${preferredModel(modelIds)}`;
  }
  if (!dotenvValue(text, "ANTHROPIC_AUTH_TOKEN")) values.ANTHROPIC_AUTH_TOKEN = token;
  const lines = parseDotenvLines(text);
  if (!lines.some((line) => line.key === "FCC_CONFIG_SCHEMA")) {
    lines.unshift({ raw: "# Managed by Free Claude Code." }, { key: "FCC_CONFIG_SCHEMA", raw: "FCC_CONFIG_SCHEMA=1" });
  }
  const written = new Set();
  const out = lines.map((line) => {
    if (line.key && Object.hasOwn(values, line.key)) {
      written.add(line.key);
      return `${line.key}=${values[line.key]}`;
    }
    return line.raw;
  });
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  for (const [key, value] of Object.entries(values)) if (!written.has(key)) out.push(`${key}=${value}`);
  return `${out.join("\n")}\n`;
}

/**
 * opencode's config with only the `pom` provider (and default model while
 * unset or stale) managed. Each model carries the POM's limits: without them
 * opencode never compacts. `input` is the whole context, so opencode keeps
 * its 20000-token compaction reserve instead of reserving a full reply.
 */
export function withOpencodeProvider(config, baseURL, models) {
  const next = { ...(config ?? {}) };
  if (!next.$schema) next.$schema = "https://opencode.ai/config.json";
  const providers = { ...(next.provider ?? {}) };
  const modelIds = models.map((model) => model.id);
  if (models.length === 0) delete providers[PROVIDER];
  else {
    providers[PROVIDER] = {
      npm: "@ai-sdk/openai-compatible",
      name: "POM",
      options: { baseURL, apiKey: "{env:POM_API_KEY}" },
      models: Object.fromEntries(
        models.map(({ id, contextWindow, maxTokens }) => [
          id,
          contextWindow && maxTokens
            ? { name: id, limit: { context: contextWindow, input: contextWindow, output: maxTokens } }
            : { name: id },
        ]),
      ),
    };
  }
  next.provider = providers;
  const current = typeof next.model === "string" ? next.model : "";
  const stale = current.startsWith(`${PROVIDER}/`) && !modelIds.includes(current.slice(PROVIDER.length + 1));
  if (modelIds.length > 0 && (!current || stale)) next.model = `${PROVIDER}/${preferredModel(modelIds)}`;
  return next;
}

/**
 * Claude Code's `~/.claude.json`: onboarding done and the workspace trusted,
 * once. Imports of files outside the workspace from a CLAUDE.md above it stay
 * off (the safe answer to Claude Code's prompt); a saved answer is kept.
 */
export function withClaudeReady(state, folder) {
  const next = { ...(state ?? {}) };
  if (next.hasCompletedOnboarding === undefined) next.hasCompletedOnboarding = true;
  const projects = { ...(next.projects ?? {}) };
  const project = { ...(projects[folder] ?? {}) };
  if (project.hasTrustDialogAccepted === undefined) project.hasTrustDialogAccepted = true;
  if (project.hasClaudeMdExternalIncludesApproved === undefined) {
    project.hasClaudeMdExternalIncludesApproved = false;
    project.hasClaudeMdExternalIncludesWarningShown = true;
  }
  projects[folder] = project;
  next.projects = projects;
  return next;
}

/** Codex's `config.toml` with the workspace trusted, unless a decision for it exists. */
export function withCodexTrust(text, folder) {
  const header = `[projects.${JSON.stringify(folder)}]`;
  if ((text ?? "").includes(header)) return undefined;
  const base = (text ?? "").replace(/\s*$/, "");
  return `${base ? `${base}\n\n` : ""}${header}\ntrust_level = "trusted"\n`;
}

/** What marks a Codex hook as herdr's: its integration runs this script. */
const HERDR_CODEX_HOOK = "herdr-agent-state.sh";

/**
 * Codex's trust hash for one `hooks.json` handler: SHA-256 over the canonical
 * (sorted keys) JSON of the normalized hook, as `codex-rs/hooks` computes it
 * (`hook_hash` and `version_for_toml`). Unset options drop out, like in TOML.
 */
export function codexHookHash(event, group, handler) {
  const shortEvent = event === "SessionEnd" || event === "Interrupt";
  const timeout = handler.timeout ?? (shortEvent ? 1 : 600);
  const normalized = {
    type: "command",
    command: handler.command,
    commandWindows: handler.commandWindows ?? handler.command_windows,
    timeout: shortEvent ? Math.min(Math.max(timeout, 1), 3) : Math.max(timeout, 1),
    async: handler.async ?? false,
    statusMessage: handler.statusMessage,
    additionalContextLimit: handler.additionalContextLimit,
  };
  const identity = { event_name: codexEventKey(event), matcher: group.matcher, hooks: [normalized] };
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(identity))).digest("hex")}`;
}

function codexEventKey(event) {
  return event.replace(/(?<!^)([A-Z])/g, "_$1").toLowerCase();
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => value[key] !== undefined && value[key] !== null)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
}

/**
 * Codex's `config.toml` with herdr's hooks from `hooks.json` trusted, so Codex
 * starts without its hook review. Only herdr's hooks are touched: a user's own
 * hooks still go through Codex's review, and a hook the user disabled stays so.
 */
export function withCodexHookTrust(text, hooksFile, hooksPath) {
  let next = text ?? "";
  for (const [event, groups] of Object.entries(hooksFile?.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    groups.forEach((group, groupIndex) => {
      (group?.hooks ?? []).forEach((handler, handlerIndex) => {
        if (handler?.type !== "command" || !String(handler.command ?? "").includes(HERDR_CODEX_HOOK)) return;
        const key = `${hooksPath}:${codexEventKey(event)}:${groupIndex}:${handlerIndex}`;
        next = withTrustedHash(next, `[hooks.state.${JSON.stringify(key)}]`, codexHookHash(event, group, handler));
      });
    });
  }
  return next === (text ?? "") ? undefined : next;
}

function withTrustedHash(text, header, hash) {
  const line = `trusted_hash = ${JSON.stringify(hash)}`;
  const start = text.indexOf(header);
  if (start < 0) {
    const base = text.replace(/\s*$/, "");
    return `${base ? `${base}\n\n` : ""}${header}\n${line}\n`;
  }
  const bodyStart = start + header.length;
  const nextTable = text.slice(bodyStart).search(/^\s*\[/m);
  const bodyEnd = nextTable < 0 ? text.length : bodyStart + nextTable;
  const body = text.slice(bodyStart, bodyEnd);
  const updated = /^trusted_hash\s*=.*$/m.test(body)
    ? body.replace(/^trusted_hash\s*=.*$/m, line)
    : body.replace(/^\n?/, `\n${line}\n`);
  return text.slice(0, bodyStart) + updated + text.slice(bodyEnd);
}

// --- Filesystem and process helpers -----------------------------------------

function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function writeIfChanged(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  if (readText(path) === text) return false;
  writeFileSync(path, text);
  return true;
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 16 * 1024 * 1024, timeout: 30 * 60_000, ...options }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${command} ${args.join(" ")}: ${(stderr || error.message).trim().slice(-800)}`));
      else resolve(stdout);
    });
  });
}

async function download(url, path) {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(10 * 60_000) });
  if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status}`);
  mkdirSync(dirname(path), { recursive: true });
  await pipeline(Readable.fromWeb(response.body), createWriteStream(path));
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

/** An executable wrapper script in `binDir` (a `.cmd` on Windows). */
function writeWrapper(binDir, name, windows, posixBody, cmdBody) {
  mkdirSync(binDir, { recursive: true });
  if (windows) {
    writeFileSync(join(binDir, `${name}.cmd`), `@echo off\r\n${cmdBody}\r\n`);
    return;
  }
  const path = join(binDir, name);
  writeFileSync(path, `#!/bin/sh\n${posixBody}\n`);
  chmodSync(path, 0o755);
}

function removeWrapper(binDir, name) {
  for (const file of [name, `${name}.cmd`]) rmSync(join(binDir, file), { force: true });
}

/** The native binary an optional platform package installed, e.g. `@anthropic-ai/claude-code-linux-x64/claude`. */
function findPlatformBinary(nodeModules, scopeDir, prefix, relative) {
  if (!nodeModules) return undefined;
  const root = join(nodeModules, scopeDir);
  if (!existsSync(root)) return undefined;
  for (const entry of readdirSync(root)) {
    if (!entry.startsWith(prefix)) continue;
    for (const candidate of relative) {
      const path = join(root, entry, candidate);
      if (existsSync(path) && statSync(path).isFile()) return path;
    }
  }
  return undefined;
}

// --- Agents already on the machine ------------------------------------------

/** Where agents' own installers and package managers put their commands, after the POM's PATH. */
export function hostAgentDirs({ platform, home, pathEnv }) {
  const windows = platform === "win32";
  const paths = windows ? path.win32 : path.posix;
  const fromPath = (pathEnv ?? "").split(windows ? ";" : ":").filter(Boolean);
  const extra = windows
    ? [paths.join(home, "AppData", "Roaming", "npm"), paths.join(home, ".local", "bin"), paths.join(home, ".bun", "bin")]
    : [
        paths.join(home, ".local", "bin"),
        paths.join(home, ".claude", "local"),
        paths.join(home, ".opencode", "bin"),
        paths.join(home, ".npm-global", "bin"),
        paths.join(home, ".bun", "bin"),
        paths.join(home, ".volta", "bin"),
        "/opt/homebrew/bin",
        "/usr/local/bin",
      ];
  return [...new Set([...fromPath, ...extra])];
}

/** How to run an installed command: npm's JavaScript entry points run on the bundled Node. */
function hostCommand(file, nodeBin) {
  let head = "";
  try {
    head = readFileSync(file, { encoding: "latin1" }).slice(0, 128);
  } catch {
    return [file];
  }
  return /^#!.*\bnode\b/.test(head) ? [nodeBin, file] : [file];
}

/**
 * Claude Code, Codex and opencode as installed on this machine, outside the
 * plugin: `{ <kind>: { path, version } }`. A command counts only when
 * `--version` answers with a version, so a broken leftover is not offered.
 */
export async function detectHostAgents({ platform, home, pathEnv, nodeBin, exclude }) {
  const dirs = hostAgentDirs({ platform, home, pathEnv });
  const nvm = join(home, ".nvm", "versions", "node");
  if (platform !== "win32" && existsSync(nvm)) {
    for (const version of readdirSync(nvm)) dirs.push(join(nvm, version, "bin"));
  }
  const found = {};
  for (const { kind } of AGENTS) {
    for (const dir of dirs) {
      const candidate = join(dir, platform === "win32" ? `${kind}.exe` : kind);
      let file;
      try {
        file = realpathSync(candidate);
        if (!statSync(file).isFile()) continue;
      } catch {
        continue;
      }
      if (exclude.some((root) => file.startsWith(root))) continue;
      const [command, ...prefix] = hostCommand(file, nodeBin);
      const output = await new Promise((resolve) => {
        execFile(command, [...prefix, "--version"], { timeout: 15_000, env: { PATH: pathEnv ?? "", HOME: home } }, (error, stdout) =>
          resolve(error ? undefined : stdout),
        );
      });
      const version = output?.match(/\d+\.\d+\.\d+[\w.+-]*/)?.[0];
      if (!version) continue;
      // The command as found (often a link its installer moves on update), not where it points today.
      found[kind] = { path: candidate, version };
      break;
    }
  }
  return found;
}

// --- Installation -------------------------------------------------------------

/**
 * Install `spec` once under `<root>/<prefix>-<hash of spec>`, then drop older
 * `<prefix>-*` directories. A directory without its `.complete` marker is
 * redone from scratch.
 */
async function installOnce(root, prefix, spec, install) {
  const id = `${prefix}-${createHash("sha256").update(JSON.stringify(spec)).digest("hex").slice(0, 16)}`;
  const target = join(root, id);
  const marker = join(target, ".complete");
  if (!existsSync(marker)) {
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    await install(target);
    writeFileSync(marker, new Date().toISOString());
    for (const entry of readdirSync(root)) {
      if (entry !== id && entry.startsWith(`${prefix}-`)) rmSync(join(root, entry), { recursive: true, force: true });
    }
  }
  return target;
}

/**
 * Install what the choice needs (see `installPlan`) under `<dataDir>/agents`
 * and write the commands the herdr panes run: `claude`, `codex` and
 * `opencode` in `binDir` for the chosen agents, none for the others. Returns
 * FCC's command directory when Claude Code or Codex is on.
 */
export async function installAgents(context) {
  const { manifest, choice, dataDir, runEnv, nodeBin, npmCli, binDir, shim, modelsPath, windows, log } = context;
  const plan = installPlan(manifest, choice);
  const agentsRoot = join(dataDir, "agents");
  mkdirSync(agentsRoot, { recursive: true });
  const env = {
    ...runEnv,
    npm_config_cache: join(dataDir, "cache", "npm"),
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
  };
  const exe = windows ? ".exe" : "";

  let nodeModules;
  const packages = Object.entries(plan.npm).map(([name, version]) => `${name}@${version}`);
  if (packages.length > 0) {
    const target = await installOnce(agentsRoot, "npm", plan.npm, async (dir) => {
      log(`installing ${packages.join(", ")} from npm`);
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "pom-agents", private: true }));
      await run(nodeBin, [npmCli, "install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", ...packages], {
        cwd: dir,
        env,
      });
    });
    nodeModules = join(target, "node_modules");
  }

  let fccBin;
  if (plan.fcc) {
    const target = await installOnce(agentsRoot, "fcc", { uv: manifest.uv, fcc: manifest.fcc }, async (dir) => {
      log(`installing uv ${manifest.uv.version}`);
      const archive = join(dataDir, "cache", manifest.uv.asset);
      if (!existsSync(archive) || sha256(archive) !== manifest.uv.sha256) await download(manifest.uv.url, archive);
      if (sha256(archive) !== manifest.uv.sha256) throw new Error(`uv ${manifest.uv.version} checksum mismatch`);
      const uvDir = join(dir, "uv");
      mkdirSync(uvDir, { recursive: true });
      if (archive.endsWith(".zip")) {
        await run("powershell.exe", ["-NoProfile", "-Command", `Expand-Archive -Force -Path '${archive}' -DestinationPath '${uvDir}'`], { env });
      } else {
        await run("tar", ["-xzf", archive, "-C", uvDir, "--strip-components=1"], { env });
      }
      log(`installing free-claude-code ${manifest.fcc.commit.slice(0, 12)}`);
      await run(join(uvDir, windows ? "uv.exe" : "uv"), ["tool", "install", "--force", "--python", manifest.fcc.python, manifest.fcc.url], {
        env: {
          ...env,
          UV_TOOL_DIR: join(dir, "tools", "venvs"),
          UV_TOOL_BIN_DIR: join(dir, "tools", "bin"),
          UV_PYTHON_INSTALL_DIR: join(dir, "python"),
          UV_CACHE_DIR: join(dataDir, "cache", "uv"),
          UV_PYTHON_PREFERENCE: "only-managed",
          UV_NO_MODIFY_PATH: "1",
        },
      });
    });
    fccBin = join(target, "tools", "bin");
  }

  const bundled = {
    claude: () => [findPlatformBinary(nodeModules, "@anthropic-ai", "claude-code-", [`claude${exe}`])],
    codex: () => [nodeBin, join(nodeModules, "@openai", "codex", "bin", "codex.js")],
    opencode: () => [findPlatformBinary(nodeModules, "", "opencode-", [join("bin", `opencode${exe}`)])],
  };
  // The real clients, found by FCC's launchers on PATH; the wrappers in binDir own the plain names.
  // FCC's own tools go on PATH too: Codex runs `fcc-codex` by name for its provider token.
  // Both go through the shim, which applies the POM model limits FCC does not pass on.
  const realBin = join(agentsRoot, "real-bin");
  const sep = windows ? ";" : ":";
  const quoted = (parts) => parts.map((part) => `"${part}"`).join(" ");
  for (const agent of AGENTS) {
    const chosen = choice.agents[agent.kind];
    if (!chosen.enabled) {
      removeWrapper(binDir, agent.kind);
      removeWrapper(realBin, agent.kind);
      continue;
    }
    const command = chosen.source === "host" ? hostCommand(chosen.path, nodeBin) : bundled[agent.kind]();
    if (!command.every((part) => part && existsSync(part))) throw new Error(`${agent.label} is missing after install`);
    if (!agent.viaFcc) {
      writeWrapper(binDir, agent.kind, windows, `exec ${quoted(command)} "$@"`, `${quoted(command)} %*`);
      continue;
    }
    const line = quoted([nodeBin, shim, agent.kind, modelsPath, ...command]);
    writeWrapper(realBin, agent.kind, windows, `exec ${line} "$@"`, `${line} %*`);
    const fcc = join(fccBin, `fcc-${agent.kind}`);
    writeWrapper(
      binDir,
      agent.kind,
      windows,
      `PATH="${realBin}${sep}${fccBin}${sep}$PATH" exec "${fcc}" "$@"`,
      `set "PATH=${realBin}${sep}${fccBin}${sep}%PATH%"\r\n"${fcc}${exe}" %*`,
    );
  }
  return { fccBin, exe };
}

// --- Configuration and FCC server -------------------------------------------

/** Write every agent's POM entries; returns true when FCC's settings changed. */
export function configureAgents({ home, workspace, llmBaseUrl, relayUrl, fccPort, models, token }) {
  const modelIds = models.map((model) => model.id);
  // herdr's integrations need each agent's config directory to exist.
  for (const directory of [join(home, ".claude"), join(home, ".codex"), join(home, ".config", "opencode")]) {
    mkdirSync(directory, { recursive: true });
  }
  writeIfChanged(
    join(home, ".config", "opencode", "opencode.json"),
    `${JSON.stringify(withOpencodeProvider(readJson(join(home, ".config", "opencode", "opencode.json")), llmBaseUrl, models), null, 2)}\n`,
  );
  writeIfChanged(join(home, ".claude.json"), `${JSON.stringify(withClaudeReady(readJson(join(home, ".claude.json")), workspace), null, 2)}\n`);
  const codexPath = join(home, ".codex", "config.toml");
  const codex = withCodexTrust(readText(codexPath), workspace);
  if (codex) writeIfChanged(codexPath, codex);
  const fccPath = join(home, ".fcc", ".env");
  const owned = { HOST: "127.0.0.1", PORT: String(fccPort), PROXY_AUTH_ENABLED: "true", LLAMACPP_BASE_URL: relayUrl };
  return writeIfChanged(fccPath, withFccSettings(readText(fccPath), owned, modelIds, token));
}

/** Trust the hooks `herdr integration install codex` wrote; run after it. */
export function trustHerdrCodexHooks(home) {
  const hooksPath = join(home, ".codex", "hooks.json");
  const configPath = join(home, ".codex", "config.toml");
  const config = withCodexHookTrust(readText(configPath), readJson(hooksPath), hooksPath);
  if (config) writeIfChanged(configPath, config);
}

/** The FCC port: the saved one while it is free, else a new one. */
export async function fccPort(home) {
  const saved = Number(dotenvValue(readText(join(home, ".fcc", ".env")), "PORT"));
  if (Number.isInteger(saved) && saved > 0 && (await portFree(saved))) return saved;
  return freePort();
}

/** Run `fcc-server` until the launcher exits; restart it when asked (new settings). */
export function superviseFcc({ fccBin, exe, runEnv, home, log }) {
  let child;
  let stopped = false;
  let restarting = false;
  const start = () => {
    child = spawn(join(fccBin, `fcc-server${exe}`), [], {
      cwd: home,
      env: { ...runEnv, BROWSER: "true" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", () => {});
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      if (/error|traceback/i.test(text)) process.stderr.write(`fcc: ${text}`);
    });
    child.on("exit", (code, signal) => {
      if (stopped) return;
      if (restarting) {
        // Asked for: start again right away, on the port the old process just released.
        restarting = false;
        start();
        return;
      }
      log(`fcc-server exited (code ${code}, signal ${signal}); restarting in 5 s`);
      setTimeout(() => !stopped && start(), 5000).unref();
    });
  };
  start();
  return {
    restart() {
      if (restarting || child?.exitCode !== null || child?.signalCode !== null) return;
      restarting = true;
      child.kill("SIGTERM");
    },
    stop() {
      stopped = true;
      child?.kill("SIGTERM");
    },
  };
}
