import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__POM_PLUGIN_CODE__ = "harness";
const { PROXY_PREFIX, resizeMessage, terminalUrl } = await import("../../ui/src/terminal/connection.ts");

test("the terminal socket goes through the POM proxy on the POM origin", () => {
  assert.equal(PROXY_PREFIX, "/api/ui/plugins/harness/proxy");
  assert.equal(
    terminalUrl(120, 32, { protocol: "http:", host: "ksia:8080" }),
    "ws://ksia:8080/api/ui/plugins/harness/proxy/terminal?cols=120&rows=32",
  );
  assert.equal(
    terminalUrl(80, 24, { protocol: "https:", host: "pom.example" }),
    "wss://pom.example/api/ui/plugins/harness/proxy/terminal?cols=80&rows=24",
  );
  assert.deepEqual(JSON.parse(resizeMessage(100, 30)), { type: "resize", cols: 100, rows: 30 });
});
