import { execFileSync } from "node:child_process"
import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"

// Playwright runs global setup with cwd at the repo root (`vp run test:web:e2e`).
const repoRoot = process.cwd()
const vpBin = join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "vp.cmd" : "vp")

const IGNORED_DIRS = new Set(["node_modules", "dist", ".git", ".turbo", "coverage"])

function newestMtime(path: string, acc: { value: number }): void {
  let stat
  try {
    stat = statSync(path)
  } catch {
    return
  }
  if (stat.isDirectory()) {
    let entries: string[]
    try {
      entries = readdirSync(path)
    } catch {
      return
    }
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry)) continue
      newestMtime(join(path, entry), acc)
    }
    return
  }
  if (stat.mtimeMs > acc.value) acc.value = stat.mtimeMs
}

function distIsFresh(): boolean {
  let distStat
  try {
    distStat = statSync(join(repoRoot, "apps", "web", "dist", "index.html"))
  } catch {
    return false
  }
  const distMtime = distStat.mtimeMs

  const sources = [
    join(repoRoot, "package.json"),
    join(repoRoot, "pnpm-workspace.yaml"),
    join(repoRoot, "apps", "yaade"),
    join(repoRoot, "packages"),
  ]
  const acc = { value: 0 }
  for (const source of sources) newestMtime(source, acc)

  return distMtime >= acc.value
}

export default function globalSetup(): void {
  if (process.env.YAADE_SKIP_E2E_BUILD === "1") return
  execFileSync("cargo", ["build", "--manifest-path", "apps/server/Cargo.toml"], {
    cwd: repoRoot,
    stdio: "inherit",
  })
  if (distIsFresh()) {
    console.log("[global-setup] apps/web/dist is newer than sources; skipping SPA build")
    return
  }
  execFileSync(vpBin, ["run", "--filter", "@yaade/web", "build"], { stdio: "inherit" })
}
