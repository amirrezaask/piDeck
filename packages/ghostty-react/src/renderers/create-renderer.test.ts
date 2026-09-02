import { strict as assert } from "node:assert";
import { test } from "vite-plus/test";
import {
  AUTO_WEBGL2_ENABLED,
  parseTerminalRendererPreference,
  terminalRendererPreferenceFromSearch,
} from "./create-renderer.js";

test("renderer query preference accepts only known explicit backends", () => {
  assert.equal(terminalRendererPreferenceFromSearch(""), "auto");
  assert.equal(terminalRendererPreferenceFromSearch("?terminalRenderer=canvas2d"), "canvas2d");
  assert.equal(terminalRendererPreferenceFromSearch("?terminalRenderer=webgl2"), "webgl2");
  assert.equal(terminalRendererPreferenceFromSearch("?terminalRenderer=webgpu"), "auto");
  assert.equal(parseTerminalRendererPreference("webgl2"), "webgl2");
  assert.equal(parseTerminalRendererPreference("other"), "auto");
});

test("auto mode prefers WebGL2 after a successful capability self-test", () => {
  assert.equal(AUTO_WEBGL2_ENABLED, true);
});
