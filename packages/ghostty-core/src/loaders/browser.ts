import type { GhosttyWasmSource } from "../runtime.js"

/** Browser/Vite loader. Assets remain injectable so Node never imports Vite URLs. */
export function browserGhosttyWasmSource(): GhosttyWasmSource {
  return {
    terminal: new URL("../vendor/ghostty-vt.wasm", import.meta.url),
    trampoline: new URL("../vendor/ghostty-write-pty.wasm", import.meta.url),
  }
}
