import { prefersReducedMotion } from "@yaade/shared"
import {
  YAADE_RATE_MENU,
  YAADE_LAYOUT_EPSILON,
  radAnimationRate,
  radLerp,
} from "./rad.js"

export type PanelRect = { x: number; y: number; w: number; h: number }

export function capturePanelLeafRects(): Map<number, PanelRect> {
  const map = new Map<number, PanelRect>()
  for (const el of document.querySelectorAll<HTMLElement>("[data-yaade-panel-leaf]")) {
    if (el.closest("[data-yaade-layout-morph-clone]")) continue
    const id = Number(el.dataset.yaadePanelLeaf)
    if (!Number.isFinite(id)) continue
    const r = el.getBoundingClientRect()
    map.set(id, { x: r.left, y: r.top, w: r.width, h: r.height })
  }
  return map
}

export type LayoutMorphOptions = {
  /** New panels grow from this rect (panelId -> spawn rect). */
  spawnFrom?: Map<number, PanelRect>
  /** RAD half-life N for menu-rate panel morph. */
  halfLifeN?: number
}

function clonePanelShell(): HTMLElement {
  const shell = document.createElement("div")
  shell.dataset.yaadeLayoutMorphClone = ""
  shell.setAttribute("aria-hidden", "true")
  shell.className =
    "pointer-events-none fixed top-0 left-0 z-[100] overflow-hidden rounded-sm border border-border/80 bg-background shadow-md"
  shell.style.willChange = "transform, opacity"
  shell.style.transformOrigin = "0 0"
  return shell
}

function panelRectSettled(current: PanelRect, target: PanelRect): boolean {
  return (
    Math.abs(current.x - target.x) < YAADE_LAYOUT_EPSILON &&
    Math.abs(current.y - target.y) < YAADE_LAYOUT_EPSILON &&
    Math.abs(current.w - target.w) < YAADE_LAYOUT_EPSILON &&
    Math.abs(current.h - target.h) < YAADE_LAYOUT_EPSILON
  )
}

/**
 * FLIP-style morph from `before` rects to current DOM layout.
 * Uses RAD exponential smoothing at menu rate (N=70).
 */
export function animateLayoutMorph(
  before: Map<number, PanelRect>,
  opts: LayoutMorphOptions = {},
): Promise<void> {
  if (prefersReducedMotion() || before.size === 0) return Promise.resolve()

  const halfLifeN = opts.halfLifeN ?? YAADE_RATE_MENU
  const spawnFrom = opts.spawnFrom ?? new Map<number, PanelRect>()
  const clones: {
    el: HTMLElement
    current: PanelRect
    to: PanelRect
    fromW: number
    fromH: number
    spawn: boolean
  }[] = []

  for (const el of document.querySelectorAll<HTMLElement>("[data-yaade-panel-leaf]")) {
    if (el.closest("[data-yaade-layout-morph-clone]")) continue
    const id = Number(el.dataset.yaadePanelLeaf)
    if (!Number.isFinite(id)) continue
    const toRect = el.getBoundingClientRect()
    const to: PanelRect = { x: toRect.left, y: toRect.top, w: toRect.width, h: toRect.height }
    const fromSeed = spawnFrom.get(id) ?? before.get(id) ?? to
    const from: PanelRect = { ...fromSeed }
    if (panelRectSettled(from, to)) continue

    const shell = clonePanelShell()
    const fromW = Math.max(1, from.w)
    const fromH = Math.max(1, from.h)
    shell.style.width = `${fromW}px`
    shell.style.height = `${fromH}px`
    shell.style.transform = `translate3d(${from.x}px, ${from.y}px, 0) scale(1, 1)`
    shell.style.opacity = spawnFrom.has(id) ? "0.85" : "0.92"
    document.body.appendChild(shell)
    clones.push({ el: shell, current: { ...from }, to, fromW, fromH, spawn: spawnFrom.has(id) })
  }

  if (clones.length === 0) return Promise.resolve()

  return new Promise(resolve => {
    let lastFrame = performance.now()
    let opacityT = 0

    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - lastFrame) / 1000)
      lastFrame = now
      const rate = radAnimationRate(halfLifeN, dt)
      opacityT = radLerp(opacityT, 1, rate)
      const alpha = 0.92 * (1 - opacityT * 0.15)
      let active = false

      for (const clone of clones) {
        const { current, to, fromW, fromH } = clone
        current.x = radLerp(current.x, to.x, rate)
        current.y = radLerp(current.y, to.y, rate)
        current.w = radLerp(current.w, to.w, rate)
        current.h = radLerp(current.h, to.h, rate)

        const sx = current.w / fromW
        const sy = current.h / fromH
        clone.el.style.transform = `translate3d(${current.x}px, ${current.y}px, 0) scale(${sx}, ${sy})`
        clone.el.style.opacity = String(alpha)

        if (!panelRectSettled(current, to)) active = true
      }

      if (active) {
        requestAnimationFrame(tick)
      } else {
        for (const { el } of clones) el.remove()
        resolve()
      }
    }

    requestAnimationFrame(tick)
  })
}
