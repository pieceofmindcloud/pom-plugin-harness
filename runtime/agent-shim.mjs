// The `claude` and `codex` that FCC's launchers find on PATH: it applies the
// POM model limits FCC cannot know, then runs the real client in the same
// terminal.
//
//   node agent-shim.mjs <claude|codex> <models.json> <command> [args...]
//
// - Claude Code: `CLAUDE_CODE_AUTO_COMPACT_WINDOW` and
//   `CLAUDE_CODE_MAX_OUTPUT_TOKENS` for the POM model FCC routes to (FCC sets
//   a 190000 window for every model).
// - Codex: the `model_catalog_json` FCC passes is rewritten with each POM
//   model's context window (FCC's llama.cpp provider falls back to 200000).
//
// Nothing changes when the limits are unknown or FCC routes elsewhere.

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { constants, homedir } from "node:os";
import { join } from "node:path";
import { claudeLimitsEnv, isWindowsBatchCommand, withPomContextWindows } from "./agents.mjs";

const [kind, modelsPath, command, ...args] = process.argv.slice(2);

function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function readModels() {
  try {
    const models = JSON.parse(readFileSync(modelsPath, "utf8"));
    return Array.isArray(models) ? models : [];
  } catch {
    return [];
  }
}

const CATALOG_OVERRIDE = /^model_catalog_json=(.*)$/;

/** The same arguments, with FCC's Codex catalog swapped for one with POM context windows. */
function codexArgs(models) {
  return args.map((arg, index) => {
    const match = ["-c", "--config"].includes(args[index - 1]) ? arg.match(CATALOG_OVERRIDE) : null;
    if (!match) return arg;
    let path;
    try {
      path = JSON.parse(match[1]);
    } catch {
      path = match[1];
    }
    let catalog;
    try {
      catalog = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return arg;
    }
    const patched = withPomContextWindows(catalog, models);
    if (!patched) return arg;
    const target = path.replace(/\.json$/, "") + ".pom.json";
    writeFileSync(target, `${JSON.stringify(patched, null, 2)}\n`);
    return `model_catalog_json=${JSON.stringify(target)}`;
  });
}

const models = readModels();
const env = { ...process.env, CHROME_DEVTOOLS_AXI_SESSION: kind };
let finalArgs = args;
if (kind === "claude") {
  const home = env.HOME ?? homedir();
  Object.assign(env, claudeLimitsEnv(readText(join(home, ".fcc", ".env")), models));
  // The version is pinned by the plugin, or managed by the user's own install outside it.
  env.DISABLE_AUTOUPDATER = "1";
} else if (kind === "codex") {
  finalArgs = codexArgs(models);
}

// The client owns the terminal: Ctrl+C reaches it through the process group,
// so the shim only waits and hands back its exit status.
for (const signal of ["SIGINT", "SIGQUIT"]) process.on(signal, () => {});
const batchCommand = isWindowsBatchCommand(command, process.platform);
const child = spawn(command, finalArgs, {
  stdio: "inherit",
  env,
  ...(batchCommand ? { shell: env.ComSpec || env.COMSPEC || "cmd.exe" } : {}),
});
for (const signal of ["SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
child.on("error", (error) => {
  process.stderr.write(`${kind}: ${error.message}\n`);
  process.exit(127);
});
child.on("exit", (code, signal) => {
  process.exit(signal ? 128 + (constants.signals[signal] ?? 0) : (code ?? 1));
});
