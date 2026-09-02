import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import {
  formatMuxTitle,
  processIdentity,
} from "./process-identity.js"

test("processIdentity maps known terminals", () => {
  assert.equal(processIdentity("nvim").label, "Neovim")
  assert.equal(processIdentity("zsh").glyph, ">_")
  assert.equal(processIdentity("btop").hue, 230)
  assert.ok(processIdentity("python").glyph.length > 0)
})

test("formatMuxTitle abbreviates home paths", () => {
  assert.equal(
    formatMuxTitle({
      cwdPath: "/Users/me/dev/yaade",
      homeDir: "/Users/me",
      processName: "zsh",
    }),
    "~/dev/yaade - shell",
  )
  assert.equal(
    formatMuxTitle({
      cwdPath: "/Users/me/a/b/c/d",
      homeDir: "/Users/me",
      processName: "nvim",
    }),
    "~/a/…/c/d - Neovim",
  )
})
