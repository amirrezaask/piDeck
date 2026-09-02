import type { BrowserContext, Page } from "@playwright/test"

export type ApiHandle = {
  pid: number
  port: number
  origin: string
  dataDir: string
  logs: () => string
}

export type BrowserHandle = {
  page: Page
  context: BrowserContext
  userDataDir: string
  close: () => Promise<void>
}
