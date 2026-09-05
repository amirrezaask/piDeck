import path from "node:path"

export function serverArtifactPath(profile: "debug" | "release"): string {
  return path.resolve(
    __dirname,
    `../../apps/server/target/${profile}`,
    process.platform === "win32" ? "yaade.exe" : "yaade",
  )
}
