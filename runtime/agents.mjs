// OpenCode next to pi, installed on first use when not present on the host.
// Its `pom` provider talks directly to the POM's OpenAI-compatible endpoint.
// Other providers and the user's chosen model are left alone.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path, { dirname, join } from "node:path";

export const PROVIDER = "pom";
/** The optional agent offered next to pi. */
export const AGENTS = [{ kind: "opencode", label: "opencode", npm: "opencode-ai" }];

// --- Pure configuration helpers (unit tested) ------------------------------

/**
 * Which agents to run and where each comes from, as saved by the optional
 * chooser: `{ agents: { <kind>: { enabled, source: "bundled" | "host", path? } } }`.
 * Missing or malformed entries default to OpenCode on, using a host install
 * when available and otherwise the pinned release.
 */
function terminalCharacter(code, modifiers = 1) {
  if (!Number.isSafeInteger(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return undefined;
  // Kitty and modifyOtherKeys encode modifiers as a one-based bit mask; Ctrl is bit 2.
  if (((modifiers - 1) & 4) !== 0) {
    if (code >= 65 && code <= 90) return String.fromCodePoint(code - 64);
    if (code >= 97 && code <= 122) return String.fromCodePoint(code - 96);
    if (code >= 64 && code <= 95) return String.fromCodePoint(code - 64);
    if (code === 32 || code === 50) return "\x00";
    if (code === 63) return "\x7f";
  }
  return code === 10 || code === 13 ? "\r" : String.fromCodePoint(code);
}

/** Decode Windows ConPTY, kitty and xterm modifyOtherKeys events to ordinary keys. */
export function terminalKeys(data) {
  const keys = [];
  for (const token of data.match(/\x1b\[[0-9;?:<=>]*[A-Za-z~_]|\x1bO[A-Za-z]|\x1b|\r\n|[\s\S]/g) ?? []) {
    const win32 = /^\x1b\[(\d*);(\d*);(\d*);(\d*);(\d*);(\d*)_$/.exec(token);
    const kitty = /^\x1b\[(\d+)(?::\d+)*(?:;(\d+)(?::(\d+))?)?u$/.exec(token);
    const other = /^\x1b\[27;(\d+);(\d+)~$/.exec(token);
    const arrow = /^\x1b\[(?:1(?:;\d+)?)?([ABCD])$/.exec(token);
    let key = token;
    if (win32) {
      const [virtualKey, , unicode, down, controlState] = win32.slice(1).map(Number);
      if (down !== 1) continue;
      const arrows = { 37: "D", 38: "A", 39: "C", 40: "B" };
      key = arrows[virtualKey]
        ? `\x1b[${arrows[virtualKey]}`
        : terminalCharacter(unicode, controlState & 0x000c ? 5 : 1);
    } else if (kitty) {
      if (Number(kitty[3] ?? 1) === 3) continue;
      key = terminalCharacter(Number(kitty[1]), Number(kitty[2] ?? 1));
    } else if (other) {
      key = terminalCharacter(Number(other[2]), Number(other[1]));
    } else if (arrow) {
      key = `\x1b[${arrow[1]}`;
    } else if (token === "\n" || token === "\r\n") {
      key = "\r";
    }
    if (key !== undefined) keys.push(key);
  }
  return keys;
}

/** Preserve escape sequences split across separate stdin data events. */
export class TerminalKeyDecoder {
  pending = "";
  suppressLineFeed = false;

  feed(data) {
    let input = this.pending + String(data);
    this.pending = "";
    const escape = input.lastIndexOf("\x1b");
    if (escape >= 0) {
      const suffix = input.slice(escape);
      if (/^\x1b(?:\[|O)?$/.test(suffix) || /^\x1b\[[0-9;?:<=>]*$/.test(suffix)) {
        this.pending = suffix;
        input = input.slice(0, escape);
      }
    }
    if (this.suppressLineFeed) {
      if (input.startsWith("\n")) input = input.slice(1);
      this.suppressLineFeed = false;
    }
    const keys = terminalKeys(input);
    if (input.endsWith("\r")) this.suppressLineFeed = true;
    return keys;
  }

  flushEscape() {
    if (this.pending !== "\x1b") return [];
    this.pending = "";
    return ["\x1b"];
  }

  get waitingForEscape() {
    return this.pending === "\x1b";
  }
}

export function hasCurrentAgentsChoice(saved) {
  return saved?.schema === 1 && typeof saved.savedAt === "string";
}

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

/** The npm packages needed when the host does not provide OpenCode. */
export function installPlan(manifest, choice) {
  const npm = {};
  for (const agent of AGENTS) {
    if (choice.agents[agent.kind]?.enabled && choice.agents[agent.kind].source === "bundled") {
      npm[agent.npm] = manifest.npm[agent.npm];
    }
  }
  return { npm };
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

// --- Filesystem and process helpers -----------------------------------------

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function writeIfChanged(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  try {
    if (readFileSync(path, "utf8") === text) return false;
  } catch {
    // First install.
  }
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

/** The native binary in OpenCode's optional platform package. */
export function bundledOpencodeBinary(nodeModules, platform = process.platform, arch = process.arch) {
  if (!nodeModules) return undefined;
  const os = { win32: "windows", darwin: "darwin", linux: "linux" }[platform];
  if (!os) return undefined;
  const packageName = `opencode-${os}-${arch}`;
  const file = join("bin", platform === "win32" ? "opencode.exe" : "opencode");
  // opencode-ai/bin is an installer placeholder. With --ignore-scripts it is
  // not replaced by the real binary, so only use the platform's npm package.
  for (const suffix of ["", "-baseline"]) {
    const binary = join(nodeModules, `${packageName}${suffix}`, file);
    if (existsSync(binary) && statSync(binary).isFile()) return binary;
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
    ? [
        paths.join(home, "AppData", "Roaming", "npm"),
        paths.join(home, ".local", "bin"),
        paths.join(home, ".claude", "local"),
        paths.join(home, ".opencode", "bin"),
        paths.join(home, ".bun", "bin"),
        paths.join(home, ".volta", "bin"),
      ]
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

/** Windows npm installs expose command shims as .cmd/.bat as well as native .exe files. */
export function hostAgentExecutableNames(kind, platform) {
  return platform === "win32" ? [`${kind}.exe`, `${kind}.cmd`, `${kind}.bat`] : [kind];
}

export function isWindowsBatchCommand(file, platform) {
  return platform === "win32" && /\.(?:cmd|bat)$/i.test(file);
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
 * OpenCode as installed on this machine, outside the
 * plugin: `{ <kind>: { path, version } }`. A command counts only when
 * `--version` answers with a version, so a broken leftover is not offered.
 */
export async function detectHostAgents({ platform, home, pathEnv, nodeBin, exclude, baseEnv = {} }) {
  const dirs = hostAgentDirs({ platform, home, pathEnv });
  const nvm = join(home, ".nvm", "versions", "node");
  if (platform !== "win32" && existsSync(nvm)) {
    for (const version of readdirSync(nvm)) dirs.push(join(nvm, version, "bin"));
  }
  const commandEnv = { PATH: pathEnv ?? "", HOME: home };
  if (platform === "win32") {
    commandEnv.USERPROFILE = home;
    for (const key of ["SystemRoot", "SYSTEMROOT", "ComSpec", "COMSPEC", "TEMP", "TMP"]) {
      if (baseEnv[key]) commandEnv[key] = baseEnv[key];
    }
  }
  const found = {};
  for (const { kind } of AGENTS) {
    for (const dir of dirs) {
      for (const name of hostAgentExecutableNames(kind, platform)) {
        const candidate = join(dir, name);
        let file;
        try {
          file = realpathSync(candidate);
          if (!statSync(file).isFile()) continue;
        } catch {
          continue;
        }
        if (exclude.some((root) => file.startsWith(root))) continue;
        const [command, ...prefix] = hostCommand(file, nodeBin);
        const commandIsBatch = isWindowsBatchCommand(command, platform);
        const output = await new Promise((resolve) => {
          execFile(
            command,
            [...prefix, "--version"],
            {
              timeout: 15_000,
              env: commandEnv,
              ...(commandIsBatch ? { shell: baseEnv.ComSpec || baseEnv.COMSPEC || "cmd.exe" } : {}),
            },
            (error, stdout, stderr) => resolve(error ? undefined : `${stdout}${stderr}`),
          );
        });
        const version = output?.match(/\d+\.\d+\.\d+[\w.+-]*/)?.[0];
        if (!version) continue;
        // The command as found (often a link its installer moves on update), not where it points today.
        found[kind] = { path: candidate, version };
        break;
      }
      if (found[kind]) break;
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
 * and write the `opencode` command in `binDir` when enabled.
 */
export async function installAgents(context) {
  const { manifest, choice, dataDir, runEnv, nodeBin, npmCli, binDir, windows, log, arch = process.arch } = context;
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
  // Retire commands from older releases even if OpenCode's download fails.
  for (const name of ["claude", "codex"]) removeWrapper(binDir, name);
  rmSync(join(agentsRoot, "real-bin"), { recursive: true, force: true });

  const packages = Object.entries(plan.npm).map(([name, version]) => `${name}@${version}`);
  const npmTarget = packages.length === 0
    ? undefined
    : await installOnce(agentsRoot, "npm", plan.npm, async (dir) => {
      log(`installing ${packages.join(", ")} from npm`);
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "pom-agents", private: true }));
      await run(nodeBin, [npmCli, "install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", ...packages], {
        cwd: dir,
        env,
      });
    });
  const nodeModules = npmTarget ? join(npmTarget, "node_modules") : undefined;
  const quoted = (parts) => parts.map((part) => `"${part}"`).join(" ");
  const windowsInvocation = (parts) => `${/\.(?:cmd|bat)$/i.test(parts[0]) ? "call " : ""}${quoted(parts)} %*`;
  for (const agent of AGENTS) {
    const chosen = choice.agents[agent.kind];
    if (!chosen.enabled) {
      removeWrapper(binDir, agent.kind);
      continue;
    }
    const command = chosen.source === "host" ? hostCommand(chosen.path, nodeBin) : [bundledOpencodeBinary(nodeModules, windows ? "win32" : process.platform, arch)];
    if (!command.every((part) => part && existsSync(part))) throw new Error(`${agent.label} is missing after install`);
    writeWrapper(
      binDir,
      agent.kind,
      windows,
      `CHROME_DEVTOOLS_AXI_SESSION=${agent.kind} exec ${quoted(command)} "$@"`,
      `set "CHROME_DEVTOOLS_AXI_SESSION=${agent.kind}"\r\n${windowsInvocation(command)}`,
    );
  }
  // Remove only plugin-owned downloads from previous releases, not private-home settings.
  for (const entry of readdirSync(agentsRoot)) {
    if (entry.startsWith("fcc-") || (entry.startsWith("npm-") && entry !== (npmTarget && path.basename(npmTarget)))) {
      rmSync(join(agentsRoot, entry), { recursive: true, force: true });
    }
  }
}

// --- Configuration ----------------------------------------------------------

/** Configure only OpenCode's POM provider; do not touch other agents' settings. */
export function configureAgents({ home, llmBaseUrl, models }) {
  const configPath = join(home, ".config", "opencode", "opencode.json");
  writeIfChanged(configPath, `${JSON.stringify(withOpencodeProvider(readJson(configPath), llmBaseUrl, models), null, 2)}\n`);
}
