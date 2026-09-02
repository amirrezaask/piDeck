/**
 * Dev vs release build chrome — favicon / document title / in-app badge.
 *
 * Vite `import.meta.env.DEV` is the source of truth (true under `vite`, false
 * in production builds served by host-server).
 *
 * Read `import.meta.env.DEV` / `.PROD` as direct member access so Vite can
 * statically replace them at build time.
 */

export { applyDevBuildBrandingToHtml } from "./build-branding-html.js"

export type BuildEnv = {
  DEV?: boolean
  MODE?: string
  PROD?: boolean
}

export function isDevBuild(env?: BuildEnv): boolean {
  if (env) {
    if (env.DEV === true) return true
    if (env.PROD === true) return false
    return env.MODE === "development"
  }
  try {
    // Vite replaces these member expressions; do not read via a copied `env` object.
    if (import.meta.env.DEV === true) return true
    if (import.meta.env.PROD === true) return false
    return import.meta.env.MODE === "development"
  } catch {
    return false
  }
}

/** Prefix the tab title in dev so it is obvious in a sea of YAADE tabs. */
export function formatAppDocumentTitle(
  base: string,
  dev: boolean = isDevBuild(),
): string {
  const title = base.trim() || "YAADE"
  if (!dev) return title
  if (title.startsWith("DEV · ")) return title
  return `DEV · ${title}`
}
