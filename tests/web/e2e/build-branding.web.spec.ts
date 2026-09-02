import { expect } from "@playwright/test"
import { test } from "../../fixtures/e2e.js"

test.describe("release build branding", () => {
  test("serves release favicon and omits the DEV badge", async ({ launchApp }) => {
    const { page } = await launchApp()

    await expect(page.locator('link[rel="icon"]')).toHaveAttribute(
      "href",
      "/favicon.png",
    )
    await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute(
      "href",
      "/apple-touch-icon.png",
    )
    await expect(page.locator("[data-yaade-build-badge]")).toHaveCount(0)

    const title = await page.evaluate(() => document.title)
    expect(title.startsWith("DEV · ")).toBe(false)

    const favicon = await page.evaluate(async () => {
      const res = await fetch("/favicon.png")
      return { ok: res.ok, status: res.status }
    })
    expect(favicon.ok).toBe(true)
    expect(favicon.status).toBe(200)
  })
})
