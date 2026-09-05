import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { isColorGlyphCluster } from "./glyph-atlas.js";

test("color atlas classification includes flags and keycaps, but respects text presentation", () => {
  for (const text of ["🧑🏽‍💻", "🇯🇵", "1️⃣", "🐈", "❤️"]) {
    assert.equal(isColorGlyphCluster(text), true, text);
  }
  for (const text of ["ASCII", "123", "世界", "♥\ufe0e", "e\u0301"]) {
    assert.equal(isColorGlyphCluster(text), false, text);
  }
});
