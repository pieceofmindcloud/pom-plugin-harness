// Minimal POM node for end-to-end tests of this plugin: it serves a real POM
// admin UI build and implements the plugin contract the way the node does,
// backed by the real `pom-plugin-host` loading the real plugin library:
// - the UI contract (`pom-plugin-ui/v1`, `crates/node/src/plugin_ui.rs`);
// - `host.configure` with the node's model endpoint and API key
//   (`crates/node/src/plugins.rs`, `spawn_host_context`);
// - the plugin UI proxy `/api/ui/plugins/:code/proxy/*` over `ui.upstream`
//   (`crates/node/src/plugin_proxy.rs`).
// Every other /api route answers 404, which the POM UI treats as an optional
// feature being absent.
//
// Usage:
//   POM_FRONTEND_DIST=<apps/frontend/dist> POM_PLUGIN_HOST=<pom-plugin-host> \
//   POM_PLUGIN_LIBRARY=<abs path to the cdylib> \
//   POM_STUB_LLM_BASE_URL=http://127.0.0.1:18431/v1 POM_STUB_API_KEY=sk-e2e \
//   node tests/e2e/pom-stub.mjs
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { extname, join, normalize, resolve } from "node:path";

const env = process.env;
const dist = resolve(env.POM_FRONTEND_DIST ?? "");
const hostBin = resolve(env.POM_PLUGIN_HOST ?? "");
const library = resolve(env.POM_PLUGIN_LIBRARY ?? "");
const port = Number(env.POM_STUB_PORT || 18480);
const dataDir = resolve(env.POM_STUB_DATA || "build/e2e-data");
const pluginCode = env.POM_STUB_PLUGIN_CODE || "harness";
const proxyPrefix = `/api/ui/plugins/${pluginCode}/proxy`;
const llmBaseUrl = env.POM_STUB_LLM_BASE_URL || `http://127.0.0.1:${port}/v1`;
const apiKey = env.POM_STUB_API_KEY || "sk-e2e";
// `/api/ui/node` answering is what tells the POM UI this node is past setup.
const NODE_INFO = {
  node_id: "e2e-node", short_id: "e2e", hostname: "e2e", profile: "admin", network_name: "e2e",
  connection_key: "", authority_level: "primary", authority_fingerprint: null, p2p_port: 0,
  gateway_port: port, admin_exposure: "localhost", admin_password_configured: false, inference_port: null,
  config: null, status: "idle", peer_count: 0, load: 0, active_model: "",
  system: {
    hostname: "e2e", os: "macos", arch: "aarch64", cpu_count: 8, load_avg: [0, 0, 0],
    ram: { total: 0, used: 0, available: 0 }, gpu_kind: "none", gpu_note: null,
  },
};
const ALLOWED_TYPES = new Set(["text/javascript", "text/css", "image/svg+xml", "application/json"]);
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json",
};

for (const [name, path] of [["POM_FRONTEND_DIST", join(dist, "index.html")], ["POM_PLUGIN_HOST", hostBin], ["POM_PLUGIN_LIBRARY", library]]) {
  if (!existsSync(path)) throw new Error(`${name}: ${path} does not exist`);
}
mkdirSync(dataDir, { recursive: true });

// --- pom-plugin-host IPC (4-byte big-endian length + JSON) -------------------

const host = spawn(hostBin, [library, pluginCode], {
  env: { ...env, POM_PLUGIN_DB: join(dataDir, `${pluginCode}.db`) },
  stdio: ["pipe", "pipe", "inherit"],
});
const pending = new Map();
let nextId = 1;
let buffer = Buffer.alloc(0);
host.stdout.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const size = buffer.readUInt32BE(0);
    if (buffer.length < 4 + size) break;
    const reply = JSON.parse(buffer.subarray(4, 4 + size).toString("utf8"));
    buffer = buffer.subarray(4 + size);
    pending.get(reply.id)?.(reply);
    pending.delete(reply.id);
  }
});
host.on("exit", (code) => {
  console.error(`pom-stub: plugin host exited (${code})`);
  process.exit(1);
});

function ipc(method, payload = null) {
  const id = nextId++;
  const body = Buffer.from(JSON.stringify({ id, method, payload }));
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(body.length);
  host.stdin.write(Buffer.concat([prefix, body]));
  return new Promise((resolveReply, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 30_000);
    pending.set(id, (reply) => {
      clearTimeout(timer);
      if (reply.ok) resolveReply(reply.result);
      else reject(new Error(reply.error));
    });
  });
}

const ready = await ipc("ready");
const manifest = await ipc("query", { operation: "ui.manifest" });
if (manifest.schema !== "pom-plugin-ui/v1" || manifest.plugin_code !== pluginCode) {
  throw new Error("plugin manifest does not match the POM contract");
}
console.error(`pom-stub: plugin ${pluginCode} ${ready.plugin_version} ready`);
// Like the node: hand the plugin its model endpoint and key once it runs.
await ipc("query", { operation: "host.configure", gateway: { openai_base_url: llmBaseUrl, api_key: apiKey } });

// --- HTTP -------------------------------------------------------------------

function send(response, status, body, headers = {}) {
  response.writeHead(status, headers);
  response.end(body);
}

async function pluginAsset(response, code, asset) {
  if (code !== pluginCode || !manifest.assets.includes(asset)) return send(response, 404, "asset não encontrado");
  try {
    const reply = await ipc("query", { operation: "ui.asset", path: asset });
    if (!ALLOWED_TYPES.has(reply.content_type)) return send(response, 404, "asset não encontrado");
    send(response, 200, Buffer.from(reply.base64, "base64"), {
      "content-type": reply.content_type,
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
    });
  } catch {
    send(response, 404, "asset não encontrado");
  }
}

// --- Plugin UI proxy (mirrors crates/node/src/plugin_proxy.rs) --------------

const DROPPED_REQUEST = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer",
  "transfer-encoding", "upgrade", "host", "cookie", "authorization", "x-pom-access-token", "x-pom-plugin-token",
]);
const DROPPED_RESPONSE = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer",
  "transfer-encoding", "upgrade", "set-cookie",
]);

function sameOrigin(headers) {
  const site = headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && site !== "none") return false;
  if (headers.origin === undefined) return true;
  const authority = headers.origin.replace(/^https?:\/\//, "");
  return authority !== headers.origin && authority.toLowerCase() === String(headers.host).toLowerCase();
}

async function upstream() {
  const reply = await ipc("query", { operation: "ui.upstream" });
  if (reply.status !== "ready") throw Object.assign(new Error(reply.error ?? "starting"), { status: 503 });
  return reply;
}

function upstreamHeaders(request, target) {
  const headers = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (!DROPPED_REQUEST.has(name)) headers[name] = value;
  }
  headers["x-forwarded-host"] = request.headers.host;
  headers["x-forwarded-proto"] = "http";
  headers["x-forwarded-prefix"] = proxyPrefix;
  headers["x-pom-plugin-token"] = target.token;
  return headers;
}

function targetPath(url) {
  const rest = url.slice(proxyPrefix.length);
  return rest.startsWith("/") ? rest : `/${rest.replace(/^\?/, "?")}`;
}

async function proxy(request, response) {
  if (!sameOrigin(request.headers)) return send(response, 403, "origem recusada");
  let target;
  try {
    target = await upstream();
  } catch (error) {
    return send(response, error.status ?? 404, error.message);
  }
  const outbound = http.request(
    { host: "127.0.0.1", port: target.port, method: request.method, path: targetPath(request.url), headers: upstreamHeaders(request, target) },
    (reply) => {
      const headers = {};
      for (const [name, value] of Object.entries(reply.headers)) if (!DROPPED_RESPONSE.has(name)) headers[name] = value;
      response.writeHead(reply.statusCode, headers);
      reply.pipe(response);
    },
  );
  outbound.on("error", () => (response.headersSent ? response.end() : send(response, 502, "plugin sem resposta")));
  request.pipe(outbound);
}

async function proxyUpgrade(request, socket, head) {
  if (!request.url.startsWith(`${proxyPrefix}/`) || !sameOrigin(request.headers)) return socket.destroy();
  let target;
  try {
    target = await upstream();
  } catch {
    return socket.destroy();
  }
  const headers = upstreamHeaders(request, target);
  headers.connection = "Upgrade";
  headers.upgrade = request.headers.upgrade;
  const lines = [`${request.method} ${targetPath(request.url)} HTTP/1.1`, `host: 127.0.0.1:${target.port}`];
  for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
  const plugin = net.connect(target.port, "127.0.0.1", () => {
    plugin.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length > 0) plugin.write(head);
    plugin.pipe(socket);
    socket.pipe(plugin);
  });
  const close = () => {
    plugin.destroy();
    socket.destroy();
  };
  plugin.on("error", close);
  socket.on("error", close);
}

function staticFile(response, pathname) {
  const relative = normalize(decodeURIComponent(pathname.replace(/^\/admin-ui\/?/, ""))).replace(/^(\.\.[/\\])+/, "");
  let file = join(dist, relative);
  if (!relative || !existsSync(file) || !extname(file)) file = join(dist, "index.html");
  send(response, 200, readFileSync(file), { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
}

const server = http
  .createServer((request, response) => {
    const url = new URL(request.url, "http://pom.invalid");
    if (url.pathname === proxyPrefix || url.pathname.startsWith(`${proxyPrefix}/`)) return void proxy(request, response);
    const asset = url.pathname.match(/^\/api\/ui\/plugins\/([^/]+)\/assets\/(.+)$/);
    if (request.method === "GET" && url.pathname === "/api/ui/plugins/ui") {
      return send(response, 200, JSON.stringify({ plugins: [{ code: pluginCode, version: ready.plugin_version, manifest }] }), {
        "content-type": "application/json",
      });
    }
    if (request.method === "GET" && asset) return void pluginAsset(response, asset[1], asset[2]);
    if (request.method === "GET" && url.pathname === "/api/ui/node") {
      return send(response, 200, JSON.stringify(NODE_INFO), { "content-type": "application/json" });
    }
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/v1/")) {
      return send(response, 404, "{}", { "content-type": "application/json" });
    }
    if (url.pathname === "/") return send(response, 302, "", { location: "/admin-ui/" });
    staticFile(response, url.pathname);
  })
  .listen(port, "0.0.0.0", () => console.error(`pom-stub: http://127.0.0.1:${port}/admin-ui/`));
server.on("upgrade", (request, socket, head) => void proxyUpgrade(request, socket, head));

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await ipc("shutdown").catch(() => {});
    host.stdin.end();
    setTimeout(() => process.exit(0), 1500);
  });
}
