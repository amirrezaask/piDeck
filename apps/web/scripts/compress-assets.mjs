#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { brotliCompressSync, constants, gzipSync } from "node:zlib"

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const dist = path.join(appRoot, "dist")
const compressibleExtensions = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".map",
  ".svg",
  ".txt",
  ".wasm",
  ".xml",
])
const minimumBytes = 1_024

function* filesIn(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) yield* filesIn(absolute)
    else if (entry.isFile()) yield absolute
  }
}

let compressed = 0
for (const file of filesIn(dist)) {
  if (!compressibleExtensions.has(path.extname(file)) || file.endsWith(".br") || file.endsWith(".gz")) {
    continue
  }
  const source = fs.readFileSync(file)
  if (source.byteLength < minimumBytes) continue
  const brotli = brotliCompressSync(source, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
    },
  })
  const gzip = gzipSync(source, { level: 9 })
  if (brotli.byteLength < source.byteLength) fs.writeFileSync(`${file}.br`, brotli)
  if (gzip.byteLength < source.byteLength) fs.writeFileSync(`${file}.gz`, gzip)
  compressed++
}

console.log(`Generated Brotli/gzip variants for ${compressed} production assets`)
