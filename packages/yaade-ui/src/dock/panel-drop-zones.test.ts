import { describe, it } from "vite-plus/test"
import assert from "node:assert/strict"
import { computeDropSites, hitTestSites, siteToAction } from "./panel-drop-zones.js"

const W = 1000
const H = 800
const FS = 13

describe("computeDropSites", () => {
  it("returns 5 sites for normal panel", () => {
    const sites = computeDropSites(W, H, FS)
    assert.equal(sites.length, 5)
  })

  it("returns [] when the dock compass cannot fit", () => {
    assert.deepEqual(computeDropSites(150, 150, FS), [])
    assert.deepEqual(computeDropSites(0, H, FS), [])
    assert.deepEqual(computeDropSites(W, 0, FS), [])
  })

  it("keeps the dock compass compact on a large panel", () => {
    const sites = computeDropSites(W, H, FS)
    for (const site of sites) {
      assert.ok(site.rect.w >= 3 * FS)
      assert.ok(site.rect.w <= 3.4 * FS + 1)
      assert.equal(site.rect.w, site.rect.h)
    }
  })

  it("center site is centered on panel", () => {
    const sites = computeDropSites(W, H, FS)
    const c = sites.find(s => s.id === "center")!
    const midX = c.rect.x + c.rect.w / 2
    const midY = c.rect.y + c.rect.h / 2
    assert.ok(Math.abs(midX - W / 2) < 1, `center x off: ${midX}`)
    assert.ok(Math.abs(midY - H / 2) < 1, `center y off: ${midY}`)
  })

  it("left site is to the left of center", () => {
    const sites = computeDropSites(W, H, FS)
    const c = sites.find(s => s.id === "center")!
    const l = sites.find(s => s.id === "left")!
    assert.ok(l.rect.x + l.rect.w < c.rect.x, "left not left of center")
  })

  it("right site is to the right of center", () => {
    const sites = computeDropSites(W, H, FS)
    const c = sites.find(s => s.id === "center")!
    const r = sites.find(s => s.id === "right")!
    assert.ok(r.rect.x > c.rect.x + c.rect.w, "right not right of center")
  })

  it("top site is above center", () => {
    const sites = computeDropSites(W, H, FS)
    const c = sites.find(s => s.id === "center")!
    const t = sites.find(s => s.id === "top")!
    assert.ok(t.rect.y + t.rect.h < c.rect.y, "top not above center")
  })

  it("bottom site is below center", () => {
    const sites = computeDropSites(W, H, FS)
    const c = sites.find(s => s.id === "center")!
    const b = sites.find(s => s.id === "bottom")!
    assert.ok(b.rect.y > c.rect.y + c.rect.h, "bottom not below center")
  })

  it("center preview covers full panel", () => {
    const sites = computeDropSites(W, H, FS)
    const c = sites.find(s => s.id === "center")!
    assert.equal(c.preview.x, 0)
    assert.equal(c.preview.y, 0)
    assert.equal(c.preview.w, W)
    assert.equal(c.preview.h, H)
  })

  it("left preview covers left half", () => {
    const sites = computeDropSites(W, H, FS)
    const l = sites.find(s => s.id === "left")!
    assert.equal(l.preview.x, 0)
    assert.equal(l.preview.y, 0)
    assert.equal(l.preview.w, W / 2)
    assert.equal(l.preview.h, H)
  })

  it("right preview covers right half", () => {
    const sites = computeDropSites(W, H, FS)
    const r = sites.find(s => s.id === "right")!
    assert.equal(r.preview.x, W / 2)
    assert.equal(r.preview.w, W / 2)
    assert.equal(r.preview.h, H)
  })

  it("top preview covers top half", () => {
    const sites = computeDropSites(W, H, FS)
    const t = sites.find(s => s.id === "top")!
    assert.equal(t.preview.x, 0)
    assert.equal(t.preview.y, 0)
    assert.equal(t.preview.w, W)
    assert.equal(t.preview.h, H / 2)
  })

  it("bottom preview covers bottom half", () => {
    const sites = computeDropSites(W, H, FS)
    const b = sites.find(s => s.id === "bottom")!
    assert.equal(b.preview.y, H / 2)
    assert.equal(b.preview.w, W)
    assert.equal(b.preview.h, H / 2)
  })
})

describe("hitTestSites", () => {
  const sites = computeDropSites(W, H, FS)

  it("pointer at panel center hits center site", () => {
    const hit = hitTestSites(W / 2, H / 2, sites)
    assert.equal(hit?.id, "center")
  })

  it("pointer inside left site rect hits left", () => {
    const l = sites.find(s => s.id === "left")!
    const hit = hitTestSites(l.rect.x + 2, l.rect.y + 2, sites)
    assert.equal(hit?.id, "left")
  })

  it("pointer inside right site rect hits right", () => {
    const r = sites.find(s => s.id === "right")!
    const hit = hitTestSites(r.rect.x + 2, r.rect.y + 2, sites)
    assert.equal(hit?.id, "right")
  })

  it("pointer inside top site rect hits top", () => {
    const t = sites.find(s => s.id === "top")!
    const hit = hitTestSites(t.rect.x + 2, t.rect.y + 2, sites)
    assert.equal(hit?.id, "top")
  })

  it("pointer inside bottom site rect hits bottom", () => {
    const b = sites.find(s => s.id === "bottom")!
    const hit = hitTestSites(b.rect.x + 2, b.rect.y + 2, sites)
    assert.equal(hit?.id, "bottom")
  })

  it("pointer at panel corner returns null (catch-all)", () => {
    assert.equal(hitTestSites(5, 5, sites), null)
    assert.equal(hitTestSites(W - 5, H - 5, sites), null)
  })

  it("returns null for empty sites array", () => {
    assert.equal(hitTestSites(W / 2, H / 2, []), null)
  })
})

describe("siteToAction", () => {
  it("center → moveToPane", () => {
    assert.deepEqual(siteToAction("center"), { kind: "moveToPane" })
  })

  it("left → split left", () => {
    assert.deepEqual(siteToAction("left"), { kind: "split", edge: "left" })
  })

  it("right → split right", () => {
    assert.deepEqual(siteToAction("right"), { kind: "split", edge: "right" })
  })

  it("top → split top", () => {
    assert.deepEqual(siteToAction("top"), { kind: "split", edge: "top" })
  })

  it("bottom → split bottom", () => {
    assert.deepEqual(siteToAction("bottom"), { kind: "split", edge: "bottom" })
  })
})
