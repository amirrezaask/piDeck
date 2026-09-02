import { test as base, expect } from "@playwright/test"
import { launchWeb, type LaunchWebOptions } from "../shell/launch-web.js"
import type { LaunchShellResult } from "../shell/driver.js"

type LaunchApp = (options?: LaunchWebOptions) => Promise<LaunchShellResult>

type Fixtures = {
  /** Launch an isolated host/browser pair and clean it up after the test. */
  launchApp: LaunchApp
}

export const test = base.extend<Fixtures>({
  // oxlint-disable-next-line no-empty-pattern -- this fixture has no dependencies
  launchApp: async ({}, use) => {
    const launched: LaunchShellResult[] = []

    await use(async options => {
      const result = await launchWeb(options)
      launched.push(result)
      return result
    })

    let firstError: unknown
    for (const result of launched.reverse()) {
      try {
        await result.app.close()
      } catch (error) {
        firstError ??= error
      }
    }
    if (firstError) throw firstError
  },
})

export { expect }
