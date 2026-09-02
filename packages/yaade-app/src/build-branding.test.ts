import assert from "node:assert/strict"
import { describe, it } from "vite-plus/test"
import {
  applyDevBuildBrandingToHtml,
  formatAppDocumentTitle,
  isDevBuild,
} from "./build-branding.js"

describe("build branding", () => {
  it("detects vite-style env flags", () => {
    assert.equal(isDevBuild({ DEV: true }), true)
    assert.equal(isDevBuild({ DEV: false, PROD: true }), false)
    assert.equal(isDevBuild({ MODE: "development" }), true)
    assert.equal(isDevBuild({ MODE: "production" }), false)
  })

  it("prefixes document titles only in dev", () => {
    assert.equal(formatAppDocumentTitle("yaade", false), "yaade")
    assert.equal(formatAppDocumentTitle("yaade", true), "DEV · yaade")
    assert.equal(formatAppDocumentTitle("YAADE · YAADE", true), "DEV · YAADE · YAADE")
    assert.equal(formatAppDocumentTitle("DEV · yaade", true), "DEV · yaade")
    assert.equal(formatAppDocumentTitle("  ", true), "DEV · YAADE")
  })

  it("rewrites favicon and seed title for the Vite HTML shell", () => {
    const html = `<!doctype html>
<html><head>
<title>YAADE</title>
<link rel="icon" type="image/png" href="/favicon.png" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
</head></html>`
    const out = applyDevBuildBrandingToHtml(html)
    assert.match(out, /href="\/favicon-dev\.png"/)
    assert.match(out, /href="\/apple-touch-icon-dev\.png"/)
    assert.match(out, /<title>DEV · YAADE<\/title>/)
    assert.doesNotMatch(out, /href="\/favicon\.png"/)
  })
})
