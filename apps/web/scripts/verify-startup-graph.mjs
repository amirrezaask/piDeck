#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import { gzipSync } from "node:zlib"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const dist = path.join(root, "dist")
const htmlPath = path.join(dist, "index.html")
const html = fs.readFileSync(htmlPath, "utf8")
const entryMatch = html.match(/<script[^>]+src="\/?assets\/(index-[^"]+\.js)"/)
if (!entryMatch) throw new Error("web entry chunk not found")

const assets = path.join(dist, "assets")
const mandatoryChunks = new Map()
const visitStaticImports = fileName => {
  if (mandatoryChunks.has(fileName)) return
  const source = fs.readFileSync(path.join(assets, fileName), "utf8")
  mandatoryChunks.set(fileName, source)
  for (const match of source.matchAll(/(?:from|import)\s*["']\.\/([^"']+\.js)["']/g)) {
    visitStaticImports(match[1])
  }
}
visitStaticImports(entryMatch[1])
const mandatoryGzipBytes = [...mandatoryChunks.values()].reduce(
  (total, source) => total + gzipSync(source).byteLength,
  0,
)
// Keep a small headroom for normal dependency updates.
const mandatoryGzipBudget = 360 * 1024
if (mandatoryGzipBytes > mandatoryGzipBudget) {
  throw new Error(
    `mandatory startup JS is ${mandatoryGzipBytes} gzip bytes; budget is ${mandatoryGzipBudget}`,
  )
}

const preloads = [...html.matchAll(/rel="modulepreload"[^>]+href="([^"]+)"/g)].map(match => match[1])
console.log(JSON.stringify({
  entry: entryMatch[1],
  mandatoryChunks: [...mandatoryChunks.keys()],
  mandatoryGzipBytes,
  mandatoryGzipBudget,
  preloads,
}, null, 2))
