import assert from "node:assert/strict";
import { test } from "node:test";
import { clipboardShortcut, osc52Text } from "../../ui/src/terminal/clipboard.ts";

const key = (letter, options = {}) => ({ type: "keydown", key: letter, ctrlKey: true, altKey: false, shiftKey: false, metaKey: false, ...options });

test("Windows clipboard shortcuts stay in the browser only when copying selected text or pasting", () => {
  assert.equal(clipboardShortcut(key("c"), true, "Win32"), "copy");
  assert.equal(clipboardShortcut(key("C"), true, "Win32"), "copy");
  assert.equal(clipboardShortcut(key("c"), false, "Win32"), undefined, "without a selection Ctrl+C still interrupts the agent");
  assert.equal(clipboardShortcut(key("v"), false, "Win32"), "paste");
  assert.equal(clipboardShortcut(key("V"), true, "Linux x86_64"), "paste");
  assert.equal(clipboardShortcut(key("v", { altKey: true }), true, "Win32"), undefined, "AltGr is not paste");
  assert.equal(clipboardShortcut(key("c", { shiftKey: true }), true, "Win32"), undefined, "preserve terminal shortcuts");
  assert.equal(clipboardShortcut(key("c", { metaKey: true }), true, "Win32"), undefined);
  assert.equal(clipboardShortcut(key("c", { type: "keyup" }), true, "Win32"), undefined);
  assert.equal(clipboardShortcut(key("c"), true, "MacIntel"), undefined, "macOS keeps its existing Command+C behavior");
});

test("Herdr OSC 52 selections decode as UTF-8 for the browser clipboard", () => {
  assert.equal(osc52Text(`c;${Buffer.from("Olá 🌎").toString("base64")}`), "Olá 🌎");
  assert.equal(osc52Text("c;?"), undefined, "clipboard queries do not overwrite the user's clipboard");
  assert.equal(osc52Text("p;SGVsbG8="), undefined, "ignore the primary selection");
  assert.equal(osc52Text("c;not-base64!"), undefined);
  assert.equal(osc52Text(`c;${"A".repeat(1_400_001)}`), undefined, "limit clipboard payloads");
});
