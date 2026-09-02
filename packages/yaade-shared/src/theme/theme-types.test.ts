import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import {
  applyYaadeThemeCss,
  defaultYaadeTheme,
  yaadeColorsFromTokens,
} from "./theme-types.js"

type MockRoot = {
  style: { setProperty(name: string, value: string): void }
  classList: { toggle(): void }
  dataset: Record<string, string | undefined>
}

function withMockDocument(run: (vars: Map<string, string>) => void): void {
  const vars = new Map<string, string>()
  const root: MockRoot = {
    style: { setProperty: (name, value) => vars.set(name, value) },
    classList: { toggle() {} },
    dataset: {},
  }
  const previous = (globalThis as { document?: { documentElement: MockRoot } }).document
  ;(globalThis as { document?: { documentElement: MockRoot } }).document = {
    documentElement: root,
  }
  try {
    run(vars)
  } finally {
    if (previous) {
      ;(globalThis as { document?: { documentElement: MockRoot } }).document = previous
    } else {
      delete (globalThis as { document?: unknown }).document
    }
  }
}

test("applies the terminal theme contract and derives compatibility colors", () => {
  withMockDocument(vars => {
    applyYaadeThemeCss(defaultYaadeTheme)
    assert.equal(vars.get("--background"), defaultYaadeTheme.tokens.background)
    assert.equal(vars.get("--success"), defaultYaadeTheme.tokens.success)
    assert.equal(vars.get("--warning"), defaultYaadeTheme.tokens.warning)
    assert.equal(vars.get("--info"), defaultYaadeTheme.tokens.info)
    assert.equal(vars.get("--yaade-bg"), defaultYaadeTheme.colors.bg)
    assert.equal(vars.get("--yaade-terminal-background"), defaultYaadeTheme.colors.bg)
    assert.equal(vars.get("--yaade-terminal-foreground"), defaultYaadeTheme.colors.text)
  })

  assert.deepEqual(
    defaultYaadeTheme.colors,
    yaadeColorsFromTokens(defaultYaadeTheme.tokens),
  )
  assert.match(defaultYaadeTheme.colors.bg, /^#[\da-f]{6}$/i)
  assert.match(defaultYaadeTheme.colors.text, /^#[\da-f]{6}$/i)
  assert.match(defaultYaadeTheme.colors.backdrop, /^rgba\(/)
})
