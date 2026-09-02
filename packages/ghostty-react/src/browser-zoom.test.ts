import { strict as assert } from "node:assert";
import { test } from "vite-plus/test";
import { isBrowserZoomShortcut, isBrowserZoomWheel } from "./browser-zoom.js";

function key(
  value: string,
  modifiers: {
    readonly altKey?: boolean;
    readonly ctrlKey?: boolean;
    readonly metaKey?: boolean;
  } = {},
): Parameters<typeof isBrowserZoomShortcut>[0] {
  return {
    altKey: modifiers.altKey ?? false,
    ctrlKey: modifiers.ctrlKey ?? false,
    key: value,
    metaKey: modifiers.metaKey ?? false,
  };
}

test("recognizes native page-zoom shortcuts on macOS", () => {
  assert.equal(isBrowserZoomShortcut(key("+", { metaKey: true }), "MacIntel"), true);
  assert.equal(isBrowserZoomShortcut(key("-", { metaKey: true }), "MacIntel"), true);
  assert.equal(isBrowserZoomShortcut(key("0", { metaKey: true }), "MacIntel"), true);
  assert.equal(isBrowserZoomShortcut(key("Add", { metaKey: true }), "MacIntel"), true);
});

test("recognizes native page-zoom shortcuts on Windows and Linux", () => {
  assert.equal(isBrowserZoomShortcut(key("=", { ctrlKey: true }), "Win32"), true);
  assert.equal(isBrowserZoomShortcut(key("-", { ctrlKey: true }), "Linux x86_64"), true);
  assert.equal(isBrowserZoomShortcut(key("0", { ctrlKey: true }), "Linux x86_64"), true);
});

test("does not take terminal or modified shortcuts away from the PTY", () => {
  assert.equal(isBrowserZoomShortcut(key("+", { ctrlKey: true }), "MacIntel"), false);
  assert.equal(isBrowserZoomShortcut(key("+", { metaKey: true }), "Linux x86_64"), false);
  assert.equal(
    isBrowserZoomShortcut(key("+", { altKey: true, ctrlKey: true }), "Linux x86_64"),
    false,
  );
  assert.equal(isBrowserZoomShortcut(key("_", { ctrlKey: true }), "Linux x86_64"), false);
  assert.equal(isBrowserZoomShortcut(key("c", { metaKey: true }), "MacIntel"), false);
});

test("recognizes browser pinch and Ctrl-wheel zoom gestures", () => {
  assert.equal(isBrowserZoomWheel({ ctrlKey: true }), true);
  assert.equal(isBrowserZoomWheel({ ctrlKey: false }), false);
});
