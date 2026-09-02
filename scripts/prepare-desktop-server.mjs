import { chmodSync, copyFileSync, mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import process from "node:process"

const mode = process.argv[2]
if (mode !== "dev" && mode !== "release") {
  throw new Error("usage: prepare-desktop-server.mjs <dev|release>")
}

const root = resolve(import.meta.dirname, "..")
const rustc = spawnSync("rustc", ["-vV"], { cwd: root, encoding: "utf8" })
if (rustc.status !== 0) {
  process.stderr.write(rustc.stderr)
  process.exit(rustc.status ?? 1)
}

const host = rustc.stdout.match(/^host: (.+)$/m)?.[1]
const target = process.env.TAURI_ENV_TARGET_TRIPLE ?? host
if (target === undefined) {
  throw new Error("could not determine the Rust target triple")
}

const cargoArgs = [
  "build",
  "--locked",
  "--manifest-path",
  "apps/server/Cargo.toml",
  "--bin",
  "yaade",
  "--target",
  target,
]
if (mode === "release") cargoArgs.push("--release")

const cargo = spawnSync("cargo", cargoArgs, { cwd: root, stdio: "inherit" })
if (cargo.status !== 0) process.exit(cargo.status ?? 1)

const extension = target.includes("windows") ? ".exe" : ""
const profile = mode === "release" ? "release" : "debug"
const source = resolve(root, "apps/server/target", target, profile, `yaade${extension}`)
const destination = resolve(
  root,
  "apps/desktop/src-tauri/binaries",
  `yaade-${target}${extension}`,
)
mkdirSync(dirname(destination), { recursive: true })
copyFileSync(source, destination)
if (extension === "") chmodSync(destination, 0o755)
console.log(`Prepared desktop server sidecar: ${destination}`)
