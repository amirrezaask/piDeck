import { readFileSync } from "node:fs"
import { strict as assert } from "node:assert"
import { test } from "vite-plus/test"

const wasmPath = new URL("./vendor/ghostty-vt.wasm", import.meta.url)
const trampolinePath = new URL("./vendor/ghostty-write-pty.wasm", import.meta.url)
const revisionPath = new URL("./vendor/VERSION", import.meta.url)

type WasmFunction = (...args: number[]) => number

type Layout = {
  size: number
  fields?: Record<string, { type: string }>
}

function getInstance(value: WebAssembly.Instance | WebAssembly.WebAssemblyInstantiatedSource) {
  return value instanceof WebAssembly.Instance ? value : value.instance
}

function getFunction(exports: WebAssembly.Exports, name: string): WasmFunction {
  const value = exports[name]
  assert.equal(typeof value, "function", `missing WASM export ${name}`)
  return value as WasmFunction
}

function layoutsFor(instance: WebAssembly.Instance): Record<string, Layout> {
  const memory = instance.exports.memory
  assert.ok(memory instanceof WebAssembly.Memory)
  const typeJson = getFunction(instance.exports, "ghostty_type_json")()
  const bytes = new Uint8Array(memory.buffer)
  let end = typeJson
  while (end < bytes.length && bytes[end] !== 0) end += 1
  return JSON.parse(new TextDecoder().decode(bytes.subarray(typeJson, end))) as Record<string, Layout>
}

test("vendored Ghostty WASM is pinned to its declared source revision", async () => {
  const revision = readFileSync(revisionPath, "utf8").trim()
  assert.match(revision, /^[0-9a-f]{40}$/)

  const source = readFileSync(wasmPath)
  const instantiated = await WebAssembly.instantiate(source, { env: { log: () => {} } })
  const instance = getInstance(instantiated)
  const memory = instance.exports.memory
  assert.ok(memory instanceof WebAssembly.Memory)
  const alloc = getFunction(instance.exports, "ghostty_wasm_alloc_u8_array")
  const free = getFunction(instance.exports, "ghostty_wasm_free_u8_array")
  const buildInfo = getFunction(instance.exports, "ghostty_build_info")
  const output = alloc(8)

  assert.equal(buildInfo(10, output), 0)
  const outputView = new DataView(memory.buffer, output, 8)
  const pointer = outputView.getUint32(0, true)
  const length = outputView.getUint32(4, true)
  const embeddedRevision = new TextDecoder().decode(
    new Uint8Array(memory.buffer, pointer, length),
  )
  free(output, 8)

  assert.equal(embeddedRevision, revision)
})

test("vendored Ghostty ABI supports the adapter's initialization and mode paths", async () => {
  const source = readFileSync(wasmPath)
  const instantiated = await WebAssembly.instantiate(source, { env: { log: () => {} } })
  const instance = getInstance(instantiated)
  const memory = instance.exports.memory
  assert.ok(memory instanceof WebAssembly.Memory)
  const layouts = layoutsFor(instance)
  assert.equal(layouts.GhosttyTerminalOptions?.size, 8)
  assert.equal(layouts.GhosttyTerminalOptions?.fields?.max_scrollback?.type, "u32")
  assert.equal("GhosttyTerminalModeConfig" in layouts, false)

  const alloc = getFunction(instance.exports, "ghostty_wasm_alloc_u8_array")
  const free = getFunction(instance.exports, "ghostty_wasm_free_u8_array")
  const allocOpaque = getFunction(instance.exports, "ghostty_wasm_alloc_opaque")
  const freeOpaque = getFunction(instance.exports, "ghostty_wasm_free_opaque")
  const terminalNew = getFunction(instance.exports, "ghostty_terminal_new")
  const terminalFree = getFunction(instance.exports, "ghostty_terminal_free")
  const terminalModeGet = getFunction(instance.exports, "ghostty_terminal_mode_get")
  const options = alloc(8)
  const optionsView = new DataView(memory.buffer, options, 8)
  optionsView.setUint16(0, 80, true)
  optionsView.setUint16(2, 24, true)
  optionsView.setUint32(4, 10_000, true)
  const terminalSlot = allocOpaque()

  assert.equal(terminalNew(0, terminalSlot, options), 0)
  const terminal = new DataView(memory.buffer).getUint32(terminalSlot, true)
  const mode = alloc(1)
  assert.equal(terminalModeGet(terminal, 1003, mode), 0)
  assert.equal(new Uint8Array(memory.buffer, mode, 1)[0], 0)

  free(mode, 1)
  terminalFree(terminal)
  freeOpaque(terminalSlot)
  free(options, 8)
})

test("PTY trampoline stays a tiny single-callback asset", async () => {
  const source = readFileSync(trampolinePath)
  assert.ok(source.byteLength < 512)
  const module = await WebAssembly.compile(source)
  const imports = WebAssembly.Module.imports(module)
  assert.deepEqual(imports.map(({ module: name, name: importName }) => `${name}.${importName}`), [
    "env.t3_write_pty",
  ])
  assert.ok(WebAssembly.Module.exports(module).some(({ name }) => name === "ghostty_write_pty"))
})
