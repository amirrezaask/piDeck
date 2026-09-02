import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import { stripDa1Responses } from "./terminal-da.js"

test("strips DA1 responses and leaves queries and other bytes", () => {
  assert.equal(stripDa1Responses("ab\x1b[?64;1;2;6;9;15;18;21;22ccd"), "abcd")
  assert.equal(stripDa1Responses("\x1b[0c"), "\x1b[0c")
  assert.equal(stripDa1Responses("plain"), "plain")
})
