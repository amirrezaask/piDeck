import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import {
  isTerminalLinkModifier,
  scanTerminalPathLinks,
  scanTerminalUrlLinks,
} from "./terminal-links.js"

test("parses file URI line and column suffixes outside the path", () => {
  assert.deepEqual(scanTerminalPathLinks("file:///tmp/project/main.ts:12:3"), [
    {
      startIndex: 0,
      length: 32,
      path: "/tmp/project/main.ts",
      line: 12,
      column: 3,
    },
  ])
})

test("parses relative and absolute source locations", () => {
  const links = scanTerminalPathLinks("at src/main.ts:4:2 from /tmp/other.ts:9")
  assert.deepEqual(
    links.map(link => ({ path: link.path, line: link.line, column: link.column })),
    [
      { path: "src/main.ts", line: 4, column: 2 },
      { path: "/tmp/other.ts", line: 9, column: undefined },
    ],
  )
})

test("parses http and https URLs and strips trailing punctuation", () => {
  const links = scanTerminalUrlLinks(
    "see https://example.com/yaade-link and HTTP://FOO.TEST/a.",
  )
  assert.deepEqual(
    links.map(link => link.url),
    ["https://example.com/yaade-link", "HTTP://FOO.TEST/a"],
  )
})

test("does not treat bare www hosts as URLs without a scheme", () => {
  assert.deepEqual(scanTerminalUrlLinks("visit www.example.com please"), [])
})

test("link modifier follows VS Code platform convention", () => {
  const prev = Object.getOwnPropertyDescriptor(globalThis, "navigator")
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { platform: "MacIntel" },
  })
  try {
    assert.equal(isTerminalLinkModifier({ metaKey: true, ctrlKey: false }), true)
    assert.equal(isTerminalLinkModifier({ metaKey: false, ctrlKey: true }), false)
  } finally {
    if (prev) Object.defineProperty(globalThis, "navigator", prev)
    else delete (globalThis as { navigator?: unknown }).navigator
  }

  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { platform: "Linux x86_64" },
  })
  try {
    assert.equal(isTerminalLinkModifier({ metaKey: false, ctrlKey: true }), true)
    assert.equal(isTerminalLinkModifier({ metaKey: true, ctrlKey: false }), false)
  } finally {
    if (prev) Object.defineProperty(globalThis, "navigator", prev)
    else delete (globalThis as { navigator?: unknown }).navigator
  }
})
