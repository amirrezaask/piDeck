export function resolveCssLengthPx(
  raw: string,
  fontSize: number,
  fallbackRem: number,
): number {
  if (raw.endsWith("rem")) {
    const rem = parseFloat(raw)
    if (Number.isFinite(rem) && rem > 0) return rem * fontSize
  } else {
    const px = parseFloat(raw)
    if (Number.isFinite(px) && px > 0) return px
  }
  return fontSize * fallbackRem
}

export function readCssLengthPx(name: string, fallbackRem: number): number {
  if (typeof document === "undefined") return fallbackRem * 13
  const root = document.documentElement
  const fontSize = parseFloat(getComputedStyle(root).fontSize) || 13
  const styles = getComputedStyle(root)
  const raw = styles.getPropertyValue(name).trim()
  const calc = /^calc\(var\((--[\w-]+)\)\s*\*\s*(\d+(?:\.\d+)?)\)$/.exec(raw)
  if (calc) {
    const multiplier = Number(calc[2])
    const base = styles.getPropertyValue(calc[1]!).trim()
    if (Number.isFinite(multiplier) && multiplier > 0 && base) {
      return resolveCssLengthPx(base, fontSize, fallbackRem / multiplier) * multiplier
    }
  }
  const resolvedCalc = /^calc\((\d+(?:\.\d+)?(?:rem|px))\s*\*\s*(\d+(?:\.\d+)?)\)$/.exec(raw)
  if (resolvedCalc) {
    return resolveCssLengthPx(resolvedCalc[1]!, fontSize, fallbackRem) * Number(resolvedCalc[2])
  }
  if (raw.startsWith("calc(")) {
    // Computed custom properties may retain arbitrarily nested calc()/var()
    // expressions. Let the browser resolve the same token the rendered row uses.
    const probe = document.createElement("div")
    probe.style.cssText =
      `position:fixed;visibility:hidden;pointer-events:none;width:0;height:var(${name})`
    root.append(probe)
    const measured = probe.getBoundingClientRect().height
    probe.remove()
    if (Number.isFinite(measured) && measured > 0) return measured
  }
  return resolveCssLengthPx(raw, fontSize, fallbackRem)
}

export type PaletteRowLayout = "single" | "detail"

export function readPaletteRowHeight(layout: PaletteRowLayout): number {
  return layout === "detail"
    ? readCssLengthPx("--yaade-palette-detail-row-height", 3)
    : readCssLengthPx("--yaade-palette-row-height", 2.5)
}

export function readTreeRowHeights(): { root: number; child: number } {
  return {
    root: readCssLengthPx("--yaade-root-row-height", 1.75),
    child: readCssLengthPx("--yaade-row-height", 1.5),
  }
}

export function readFlatRowHeight(): number {
  return readCssLengthPx("--yaade-flat-row-height", 2.5)
}

/** Root font size in CSS px (UI zoom / appearance scale). */
export function readRootFontSizePx(): number {
  if (typeof document === "undefined") return 13
  return parseFloat(getComputedStyle(document.documentElement).fontSize) || 13
}

/**
 * Palette row chrome outside the label text:
 * list `px-0.5` + row `mx-1.5`/`px-2.5` + FileIcon `size-3.5` + `gap-2`.
 */
export const PALETTE_LISTER_CHROME_PX = 4 + 12 + 20 + 14 + 8

export type ListerLabelFontOptions = {
  /** Use `--font-mono` (file paths). Default sans. */
  mono?: boolean
  /** Relative to root font-size. Default `0.95` (`text-sm`). */
  sizeRem?: number
}

/** CSS `font` shorthand for canvas / layout label measurement. */
export function readListerLabelFont(options: ListerLabelFontOptions = {}): string {
  const sizeRem = options.sizeRem ?? 0.95
  const rootPx = readRootFontSizePx()
  const sizePx = rootPx * sizeRem
  if (typeof document === "undefined") {
    return `${sizePx}px ${options.mono ? "ui-monospace, monospace" : "sans-serif"}`
  }
  const cs = getComputedStyle(document.documentElement)
  const mono = cs.getPropertyValue("--font-mono").trim() || "ui-monospace, monospace"
  const sans = cs.getPropertyValue("--font-sans").trim() || cs.fontFamily || "sans-serif"
  return `${sizePx}px ${options.mono ? mono : sans}`
}

export type MeasureLongestItemOptions = ListerLabelFontOptions & {
  /** Extra width for icons, padding, gaps (not part of the label string). */
  chromePx?: number
  /** Override full CSS `font` shorthand (wins over mono/sizeRem). */
  font?: string
}

let measureCanvas: HTMLCanvasElement | null = null

/** Single-label width in CSS px (canvas when available; mono-ish fallback otherwise). */
export function measureTextWidthPx(text: string, font: string): number {
  if (!text) return 0
  if (typeof document !== "undefined") {
    if (!measureCanvas) measureCanvas = document.createElement("canvas")
    const ctx = measureCanvas.getContext("2d")
    if (ctx) {
      ctx.font = font
      return ctx.measureText(text).width
    }
  }
  const sizeMatch = /(\d+(?:\.\d+)?)px/.exec(font)
  const size = sizeMatch ? parseFloat(sizeMatch[1]!) : 13
  return text.length * size * 0.6
}

/**
 * Preferred content width for a lister: longest label + optional chrome.
 * Callers (PaletteShell, overlays) use this to size dialogs so paths aren't truncated.
 */
export function measureLongestItemContentWidth(
  labels: Iterable<string>,
  options: MeasureLongestItemOptions = {},
): number {
  const font = options.font ?? readListerLabelFont(options)
  const chromePx = options.chromePx ?? 0
  let longest = 0
  for (const label of labels) {
    const w = measureTextWidthPx(label, font)
    if (w > longest) longest = w
  }
  return longest + chromePx
}

/** VS Code-like quick-input widths (`picker` 44rem / `wide` 52rem). */
export function readPaletteSizeMinWidthPx(size: "picker" | "wide"): number {
  return readRootFontSizePx() * (size === "wide" ? 52 : 44)
}
