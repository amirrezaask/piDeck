import type { DropAction } from "@yaade/shared"

export type DropSiteKind = "center" | "left" | "right" | "top" | "bottom"

export type SiteRect = { x: number; y: number; w: number; h: number }

export type DropSite = {
  id: DropSiteKind
  rect: SiteRect    // hit-test box, panel-relative px
  preview: SiteRect // future-split highlight rect
}

/**
 * Compute five compact dock targets centered on the panel. The whole compass
 * must fit before it is shown; cramped panes keep their terminal usable.
 */
export function computeDropSites(w: number, h: number, fontSize: number): DropSite[] {
  if (w <= 0 || h <= 0 || fontSize <= 0) return []
  const minDim = Math.min(w, h)
  const minSize = 3 * fontSize
  const gapRatio = 0.2
  const compassUnits = 3 + gapRatio * 2
  const maxSize = (minDim - fontSize * 2) / compassUnits
  if (maxSize < minSize) return []

  const size = Math.min(Math.ceil(3.4 * fontSize), maxSize)
  const half = size / 2
  const gap = Math.ceil(size * gapRatio)
  const cx = w / 2
  const cy = h / 2

  const siteRect = (ox: number, oy: number): SiteRect => ({
    x: cx + ox - half,
    y: cy + oy - half,
    w: size,
    h: size,
  })

  const step = size + gap

  const sites: DropSite[] = [
    {
      id: "center",
      rect: siteRect(0, 0),
      preview: { x: 0, y: 0, w, h },
    },
    {
      id: "left",
      rect: siteRect(-step, 0),
      preview: { x: 0, y: 0, w: w / 2, h },
    },
    {
      id: "right",
      rect: siteRect(step, 0),
      preview: { x: w / 2, y: 0, w: w / 2, h },
    },
    {
      id: "top",
      rect: siteRect(0, -step),
      preview: { x: 0, y: 0, w, h: h / 2 },
    },
    {
      id: "bottom",
      rect: siteRect(0, step),
      preview: { x: 0, y: h / 2, w, h: h / 2 },
    },
  ]

  return sites
}

/** Return whichever site the pointer is inside, or null (catch-all). */
export function hitTestSites(
  mouseX: number,
  mouseY: number,
  sites: DropSite[],
): DropSite | null {
  for (const site of sites) {
    const { x, y, w, h } = site.rect
    if (mouseX >= x && mouseX <= x + w && mouseY >= y && mouseY <= y + h) {
      return site
    }
  }
  return null
}

export function siteToAction(kind: DropSiteKind): DropAction {
  if (kind === "center") return { kind: "moveToPane" }
  return { kind: "split", edge: kind }
}

/** Per-overlay drop-site cache. Avoids JSON round-trip on the drag hot path. */
export const dropSitesRegistry = new WeakMap<HTMLElement, DropSite[]>()
