#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const builtExtension = path.join(
  repoRoot,
  "apps/chrome-extension/build/chrome-mv3",
)
const output = path.join(repoRoot, "dist/extension")

if (!fs.existsSync(path.join(builtExtension, "manifest.json"))) {
  throw new Error(`Chrome extension build missing at ${builtExtension}`)
}

fs.mkdirSync(path.dirname(output), { recursive: true })
fs.rmSync(output, { recursive: true, force: true })
fs.cpSync(builtExtension, output, { recursive: true })
console.log(`Chrome extension: ${output}`)
