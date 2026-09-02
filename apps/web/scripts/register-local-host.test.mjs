import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "vite-plus/test"
import {
  addLocalHostEntry,
  ensureLocalHostRegistration,
  hasLocalHostEntry,
} from "./register-local-host.mjs"

test("adds the ide.local loopback entry without disturbing existing hosts", () => {
  const contents = "127.0.0.1 localhost\n"
  const next = addLocalHostEntry(contents)

  assert.equal(hasLocalHostEntry(next), true)
  assert.match(next, /127\.0\.0\.1\s+localhost/)
  assert.match(next, /127\.0\.0\.1\s+ide\.local/)
})

test("does not duplicate an existing ide.local entry", () => {
  const contents = "127.0.0.1 localhost ide.local\n"
  assert.equal(addLocalHostEntry(contents), contents)
})

test("rejects a conflicting ide.local entry", () => {
  assert.throws(
    () => addLocalHostEntry("192.168.1.20 ide.local\n"),
    /non-loopback address/,
  )
})

test("registers a writable hosts file at startup", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-local-host-test-"))
  const hostsFile = path.join(tempDir, "hosts")
  try {
    const first = ensureLocalHostRegistration({ hostsFile, elevate: false })
    const second = ensureLocalHostRegistration({ hostsFile, elevate: false })

    assert.equal(first.changed, true)
    assert.equal(second.changed, false)
    assert.equal(hasLocalHostEntry(fs.readFileSync(hostsFile, "utf8")), true)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})
