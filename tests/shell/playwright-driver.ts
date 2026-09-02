import type { Page } from "@playwright/test"
import type { ShellDriver } from "./driver.js"

/**
 * Keep the small shell-specific page surface while returning native
 * Playwright locators. This preserves the launch harness abstraction without
 * losing strict locator semantics or web-first assertions in tests.
 */
export function wrapPlaywrightPage(page: Page): ShellDriver {
  return {
    evaluate<R, Arg>(
      pageFunction: ((arg: Arg) => R | Promise<R>) | (() => R | Promise<R>),
      arg?: Arg,
    ): Promise<R> {
      if (arg === undefined) {
        // SAFETY: The branch proves the callback is being invoked without an argument.
        return page.evaluate(pageFunction as never) as Promise<R>
      }
      // SAFETY: ShellDriver forwards the same callback and argument together.
      return page.evaluate(pageFunction as never, arg as never) as Promise<R>
    },
    waitForFunction(pageFunction, arg, options) {
      // SAFETY: ShellDriver preserves Playwright's callback/argument pairing;
      // `never` only bridges the overloaded Page API at this adapter boundary.
      return page
        .waitForFunction(pageFunction as never, arg as never, options)
        .then(() => undefined)
    },
    waitForLoadState(state) {
      return page.waitForLoadState(state)
    },
    waitForResponse(predicate, options) {
      return page
        .waitForResponse(
          // SAFETY: ShellResponse is the subset exposed by this adapter.
          predicate as Parameters<Page["waitForResponse"]>[0],
          options,
        )
        .then(() => undefined)
    },
    keyboard: page.keyboard,
    mouse: page.mouse,
    locator(selector) {
      return page.locator(selector)
    },
    getByRole(role, options) {
      return page.getByRole(
        // SAFETY: callers use the ARIA role names accepted by Playwright.
        role as Parameters<Page["getByRole"]>[0],
        {
          ...options,
          exact: true,
        },
      )
    },
    getByPlaceholder(text) {
      return page.getByPlaceholder(text)
    },
    getByLabel(text) {
      return page.getByLabel(text)
    },
    getByText(text, options) {
      return page.getByText(text, options)
    },
    async isVisible(selector) {
      return page.locator(selector).first().isVisible()
    },
    async count(selector) {
      return page.locator(selector).count()
    },
    async textContent(selector) {
      return (await page.locator(selector).first().textContent()) ?? ""
    },
    async clickSelector(selector) {
      await page.locator(selector).click()
    },
    async fillSelector(selector, value) {
      await page.locator(selector).fill(value)
    },
    setViewportSize(size) {
      return page.setViewportSize(size)
    },
    emulateMedia(options) {
      return page.emulateMedia(options)
    },
    viewportSize() {
      return page.viewportSize()
    },
    async screenshot() {
      return (await page.screenshot({ type: "png" })).toString("base64")
    },
    reload(options) {
      return page.reload(options).then(() => undefined)
    },
    addInitScript(script) {
      return page.addInitScript(script).then(() => undefined)
    },
  }
}
