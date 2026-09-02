import fs from "node:fs/promises"
import { fileURLToPath } from "node:url"
import type { GhosttyWasmSource } from "../runtime.js"

export async function nodeGhosttyWasmSource(): Promise<GhosttyWasmSource> {
  const terminal = await fs.readFile(fileURLToPath(new URL("../vendor/ghostty-vt.wasm", import.meta.url)))
  const trampoline = await fs.readFile(fileURLToPath(new URL("../vendor/ghostty-write-pty.wasm", import.meta.url)))
  return { terminal, trampoline }
}
