import assert from "node:assert/strict"
import { describe, it } from "vite-plus/test"
import {
  canonicalizeFileUri,
  fileUriToPath,
  normalizeFsPath,
  pathToFileUri,
} from "./uri.js"

describe("normalizeFsPath", () => {
  it("collapses . and .. segments", () => {
    assert.equal(normalizeFsPath("/Users/a/../b/./c.ts"), "/Users/b/c.ts")
    assert.equal(normalizeFsPath("/Users/./foo"), "/Users/foo")
  })

  it("keeps absolute root", () => {
    assert.equal(normalizeFsPath("/"), "/")
  })
})

describe("canonicalizeFileUri", () => {
  it("normalizes .. and percent-encoding to one form", () => {
    assert.equal(
      canonicalizeFileUri("file:///Users/a/../b/c.ts"),
      "file:///Users/b/c.ts",
    )
    assert.equal(
      canonicalizeFileUri("file:///Users/foo/My%20File.ts"),
      "file:///Users/foo/My File.ts",
    )
  })

  it("matches pathToFileUri for the same absolute path", () => {
    const path = "/tmp/proj/src/index.ts"
    assert.equal(canonicalizeFileUri(pathToFileUri(path)), pathToFileUri(path))
    assert.equal(fileUriToPath(pathToFileUri(path)), path)
  })
})
