import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "..")
const outputDirectory = mkdtempSync(path.join(tmpdir(), "yaade-ghostty-parity-"))
const nativeOutput = path.join(outputDirectory, "native.json")
const wasmOutput = path.join(outputDirectory, "wasm.json")
const vp = process.platform === "win32" ? "vp.cmd" : "vp"
let succeeded = false

function run(command, args, extraEnvironment) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...extraEnvironment },
    shell: process.platform === "win32",
    stdio: "inherit",
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status ?? "no status"}`)
  }
}

try {
  run(
    "cargo",
    [
      "test",
      "--manifest-path",
      "crates/ghostty-vt/Cargo.toml",
      "--test",
      "corpus",
      "corpus_native_assertions_and_optional_export",
      "--",
      "--exact",
    ],
    { YAADE_GHOSTTY_CORPUS_OUTPUT: nativeOutput },
  )
  run(
    vp,
    ["test", "packages/ghostty-core/src/corpus-wasm.test.ts"],
    { YAADE_GHOSTTY_CORPUS_OUTPUT: wasmOutput },
  )
  run(
    vp,
    ["test", "packages/ghostty-core/src/corpus-parity.test.ts"],
    {
      YAADE_GHOSTTY_NATIVE_OBSERVATION: nativeOutput,
      YAADE_GHOSTTY_WASM_OBSERVATION: wasmOutput,
    },
  )
  const native = JSON.parse(readFileSync(nativeOutput, "utf8"))
  const wasm = JSON.parse(readFileSync(wasmOutput, "utf8"))
  console.log(`Ghostty parity revision native=${native.revision} wasm=${wasm.revision}`)
  for (const fixture of native.fixtures) {
    console.log(`Ghostty parity fixture ${fixture.id} bytes=${fixture.sourceLength} sha256=${fixture.sourceSha256}`)
  }
  succeeded = true
} finally {
  if (succeeded) {
    rmSync(outputDirectory, { recursive: true, force: true })
  } else {
    console.error(`Ghostty parity failure artifacts: ${outputDirectory}`)
  }
}
