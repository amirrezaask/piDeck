#!/usr/bin/env node
/** Build the web client into the single YAADE Rust release binary. */
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const executableName = process.platform === "win32" ? "yaade.exe" : "yaade"
const builtBinary = path.join(repoRoot, "apps/server/target/release", executableName)
const output = path.join(repoRoot, "dist", executableName)
const vpBin = path.join(
  repoRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "vp.cmd" : "vp",
)

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

run(vpBin, ["run", "@pideck/client-web#build"])
run("pnpm", ["build:extension"])
run("cargo", [
  "build",
  "--release",
  "--locked",
  "--features",
  "embedded-web",
  "--manifest-path",
  "apps/server/Cargo.toml",
])

if (!fs.existsSync(builtBinary)) {
  throw new Error(`Rust release binary missing at ${builtBinary}`)
}
fs.mkdirSync(path.dirname(output), { recursive: true })
fs.rmSync(path.join(repoRoot, "dist/yaade-server"), { recursive: true, force: true })
fs.rmSync(output, { recursive: true, force: true })
fs.copyFileSync(builtBinary, output)
fs.chmodSync(output, 0o755)
console.log(`YAADE release binary: ${output}`)
