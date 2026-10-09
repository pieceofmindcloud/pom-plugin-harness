// `pom-agents`: choose which agents run next to pi.
//
//   node agent-setup.mjs <data dir>
//
// The launcher opens it in a "Setup" tab the first time and it can be run from
// any pane later. It reads what the launcher found (`agents-detected.json`:
// agents already installed on this machine and the pinned versions), saves the
// choice to `agents-choice.json`, then follows `agents-status.json` while the
// launcher installs and opens a tab per agent.

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENTS, normalizeChoice, terminalKeys } from "./agents.mjs";

const dataDir = process.argv[2];
const detectedPath = join(dataDir, "agents-detected.json");
const choicePath = join(dataDir, "agents-choice.json");
const statusPath = join(dataDir, "agents-status.json");

const ESC = "\x1b[";
const bold = (text) => `${ESC}1m${text}${ESC}22m`;
const dim = (text) => `${ESC}2m${text}${ESC}22m`;
const green = (text) => `${ESC}32m${text}${ESC}39m`;
const red = (text) => `${ESC}31m${text}${ESC}39m`;

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

const found = readJson(detectedPath);
if (!found) {
  process.stderr.write("pom-agents: the plugin has not looked for agents yet; try again in a moment.\n");
  process.exit(1);
}
const detected = found.detected ?? {};
const versions = found.versions ?? {};
const saved = readJson(choicePath);
const choice = normalizeChoice(saved, detected);

// The machine user's home (the panes run with the plugin's private one).
const home = found.home ?? "";
const shortPath = (path) => (home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path);

/** What happens to an agent, as `[text, dimmed suffix]`. */
function describe(agent) {
  const chosen = choice.agents[agent.kind];
  const host = detected[agent.kind];
  if (chosen.source === "host") return [`use ${host.version} from ${shortPath(host.path)}`, ""];
  const download = `download ${versions[agent.npm] ?? ""}`.trim();
  return [download, host ? ` (${host.version} is on this machine)` : ""];
}

/** Cut to the terminal width: a wrapped row would break the menu. */
function fit(text, width) {
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

let cursor = 0;
function render() {
  const lines = [
    "",
    ` ${bold("POM agents")}`,
    "",
    " pi is always here. Choose what runs next to it:",
    "",
  ];
  AGENTS.forEach((agent, index) => {
    const chosen = choice.agents[agent.kind];
    const pointer = index === cursor ? bold("›") : " ";
    const box = chosen.enabled ? green("[x]") : "[ ]";
    const label = agent.label.padEnd(12);
    const [text, note] = describe(agent);
    const room = (process.stdout.columns || 80) - 20;
    const detail = fit(`${text}${note}`, room);
    const shown = detail.length > text.length ? `${detail.slice(0, text.length)}${dim(detail.slice(text.length))}` : detail;
    lines.push(` ${pointer} ${box} ${index === cursor ? bold(label) : label} ${chosen.enabled ? shown : dim(detail)}`);
  });
  const hostHere = detected[AGENTS[cursor].kind];
  const hints = ["↑↓ move", "space select", "a all"];
  if (hostHere) hints.push(choice.agents[AGENTS[cursor].kind].source === "host" ? "d download instead" : "d use this machine's");
  hints.push("enter install", "q later");
  lines.push("", ` ${dim(hints.join(" · "))}`, "");
  process.stdout.write(`${ESC}?25l${ESC}2J${ESC}H${lines.join("\n")}`);
}

function save() {
  const next = { savedAt: new Date().toISOString(), agents: choice.agents };
  writeFileSync(`${choicePath}.tmp`, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(`${choicePath}.tmp`, choicePath);
  return next.savedAt;
}

/** Print the launcher's progress for this choice until it is applied. */
function follow(savedAt) {
  let last = "";
  const timer = setInterval(() => {
    const status = readJson(statusPath);
    if (status?.savedAt !== savedAt) return;
    if (status.message && status.message !== last) {
      last = status.message;
      process.stdout.write(` ${status.state === "error" ? red(status.message) : status.message}\n`);
    }
    if (status.state === "ready" || status.state === "error") {
      clearInterval(timer);
      process.exit(status.state === "ready" ? 0 : 1);
    }
  }, 500);
}

function restoreTerminal() {
  process.stdin.setRawMode(false);
  process.stdout.write(`${ESC}?25h`);
}

function finish() {
  restoreTerminal();
  process.stdin.pause();
  const enabled = AGENTS.filter((agent) => choice.agents[agent.kind].enabled).map((agent) => agent.label);
  process.stdout.write(`${ESC}2J${ESC}H\n ${bold("POM agents")}\n\n`);
  process.stdout.write(` ${enabled.length > 0 ? `Setting up ${enabled.join(", ")}.` : "Only pi will run."} Run ${bold("pom-agents")} any time to change this.\n\n`);
  follow(save());
}

if (!process.stdin.isTTY) {
  follow(save());
} else {
  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  // One read can carry several keys (fast typing, a paste): handle each in turn.
  process.stdin.on("data", (data) => {
    for (const key of terminalKeys(data)) {
      if (onKey(key) === "done") return;
    }
    render();
  });
  const onKey = (key) => {
    const agent = AGENTS[cursor];
    const chosen = choice.agents[agent.kind];
    if (key === "\x1b[A" || key === "\x1bOA" || key === "k") cursor = (cursor + AGENTS.length - 1) % AGENTS.length;
    else if (key === "\x1b[B" || key === "\x1bOB" || key === "j") cursor = (cursor + 1) % AGENTS.length;
    else if (key === " ") chosen.enabled = !chosen.enabled;
    else if (key === "a") {
      const all = AGENTS.every((entry) => choice.agents[entry.kind].enabled);
      for (const entry of AGENTS) choice.agents[entry.kind].enabled = !all;
    } else if (key === "d" && detected[agent.kind]) {
      choice.agents[agent.kind] =
        chosen.source === "host"
          ? { enabled: chosen.enabled, source: "bundled" }
          : { enabled: chosen.enabled, source: "host", path: detected[agent.kind].path };
    } else if (key === "\r") {
      finish();
      return "done";
    } else if (key === "q" || key === "\x1b" || key === "\x03") {
      restoreTerminal();
      process.stdout.write(`${ESC}2J${ESC}H\n Nothing changed. Run ${bold("pom-agents")} to choose later.\n\n`);
      process.exit(0);
    }
    return undefined;
  };
  process.stdout.on("resize", render);
  render();
}
