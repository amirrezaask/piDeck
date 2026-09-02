/** Minimal HTTP response surface exposed to browser tests. */
export type ShellResponse = {
  url(): string
  status(): number
  request(): { method(): string }
}

/**
 * Locators are the real Playwright locators. Keeping the native type here
 * means tests can use Playwright's web-first assertions directly instead of
 * reading a value and asserting on the resulting snapshot.
 */
export type ShellLocator = import("@playwright/test").Locator

/** Minimal page surface used by browser tests. */
export type ShellDriver = {
  evaluate<R, Arg>(pageFunction: (arg: Arg) => R | Promise<R>, arg: Arg): Promise<R>
  evaluate<R>(pageFunction: () => R | Promise<R>): Promise<R>
  waitForFunction<R>(
    pageFunction:
      | ((arg: R) => boolean | Promise<boolean>)
      | (() => boolean | Promise<boolean>),
    arg?: R,
    options?: { timeout?: number },
  ): Promise<void>
  waitForLoadState(state?: "load" | "domcontentloaded"): Promise<void>
  /** Resolve when a network response matching the predicate is observed. */
  waitForResponse(
    predicate: (response: ShellResponse) => boolean,
    options?: { timeout?: number },
  ): Promise<void>
  keyboard: {
    press(key: string): Promise<void>
    type(text: string, options?: { delay?: number }): Promise<void>
    down(key: string): Promise<void>
    up(key: string): Promise<void>
  }
  mouse: {
    move(x: number, y: number, options?: { steps?: number }): Promise<void>
    down(): Promise<void>
    up(): Promise<void>
    click(x: number, y: number, options?: { button?: "left" | "right" | "middle" }): Promise<void>
  }
  locator(selector: string): ShellLocator
  getByRole(role: string, options?: { name?: string | RegExp }): ShellLocator
  getByPlaceholder(text: string | RegExp): ShellLocator
  getByLabel(text: string | RegExp): ShellLocator
  getByText(text: string | RegExp, options?: { exact?: boolean }): ShellLocator
  isVisible(selector: string): Promise<boolean>
  count(selector: string): Promise<number>
  textContent(selector: string): Promise<string>
  clickSelector(selector: string): Promise<void>
  fillSelector(selector: string, value: string): Promise<void>
  setViewportSize(size: { width: number; height: number }): Promise<void>
  emulateMedia(options: { colorScheme: "light" | "dark" | "no-preference" }): Promise<void>
  viewportSize(): { width: number; height: number } | null
  screenshot(): Promise<string>
  reload(options?: { waitUntil?: "load" | "domcontentloaded" | "networkidle" }): Promise<void>
  addInitScript(script: () => void): Promise<void>
}

export type ShellApp = {
  close(): Promise<void>
}

export type LaunchShellResult = {
  app: ShellApp
  page: ShellDriver
  /** Host HOME used for URL path resolution (when overridden in e2e). */
  homeDir?: string
  /** Base origin of the host (no path). */
  baseUrl?: string
}
