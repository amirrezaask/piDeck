import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useDroppable } from "@dnd-kit/core"
import {
  PanelLeftIcon,
  PanelRightIcon,
  PanelTopIcon,
  PanelBottomIcon,
  SquareIcon,
} from "lucide-react"
import type { PanelId } from "@yaade/shared"
import { prefersReducedMotion } from "@yaade/shared"
import {
  YAADE_LAYOUT_EPSILON,
  YAADE_RATE_MENU,
  radAnimationRate,
  radLerp,
} from "../motion/rad.js"
import { cn } from "@/lib/utils.js"
import { usePanelDragSource } from "./PanelDragContext.js"
import { useDropHot } from "./TabDndRoot.js"
import { dropDndId } from "./tab-dnd-types.js"
import {
  computeDropSites,
  dropSitesRegistry,
  siteToAction,
  type DropSite,
  type DropSiteKind,
  type SiteRect,
} from "./panel-drop-zones.js"

function useElementSize(
  ref: React.RefObject<HTMLDivElement | null>,
  enabled: boolean,
): { w: number; h: number } {
  const [size, setSize] = useState({ w: 0, h: 0 })
  useEffect(() => {
    if (!enabled) {
      setSize({ w: 0, h: 0 })
      return
    }
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(entries => {
      const entry = entries[0]
      if (!entry) return
      setSize({ w: entry.contentRect.width, h: entry.contentRect.height })
    })
    ro.observe(el)
    const r = el.getBoundingClientRect()
    setSize({ w: r.width, h: r.height })
    return () => ro.disconnect()
  }, [enabled, ref])
  return size
}

function useFontSize(ref: React.RefObject<HTMLDivElement | null>): number {
  const [fs, setFs] = useState(13)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const v = parseFloat(getComputedStyle(el).fontSize)
    if (!isNaN(v) && v > 0) setFs(v)
  }, [ref])
  return fs
}

function siteIcon(kind: DropSiteKind) {
  const cls = "size-4"
  switch (kind) {
    case "center":
      return <SquareIcon className={cls} />
    case "left":
      return <PanelLeftIcon className={cls} />
    case "right":
      return <PanelRightIcon className={cls} />
    case "top":
      return <PanelTopIcon className={cls} />
    case "bottom":
      return <PanelBottomIcon className={cls} />
    default: {
      const _exhaustive: never = kind
      return _exhaustive
    }
  }
}

function DropSiteTarget({
  panelId,
  site,
  entered,
  hot,
}: {
  panelId: PanelId
  site: DropSite
  entered: boolean
  hot: boolean
}) {
  const { setNodeRef } = useDroppable({
    id: dropDndId(panelId, site.id),
    data: { type: "split", panelId, zone: site.id },
  })

  return (
    <div
      ref={setNodeRef}
      data-drop-site={site.id}
      data-yaade-drop-hot={hot ? "" : undefined}
      aria-hidden="true"
      className={cn(
        "pointer-events-auto absolute flex items-center justify-center rounded-md border shadow-md transition-[opacity,transform,background-color,border-color,color,box-shadow] duration-[var(--yaade-motion-dnd-site)] ease-[var(--yaade-ease-out)]",
        entered ? "opacity-100" : "opacity-0",
        hot
          ? "border-primary bg-primary text-primary-foreground shadow-lg"
          : "border-border bg-popover text-muted-foreground",
      )}
      style={{
        left: site.rect.x,
        top: site.rect.y,
        width: site.rect.w,
        height: site.rect.h,
        transform: entered
          ? hot
            ? "scale(1.06)"
            : "scale(1)"
          : "scale(0.96)",
      }}
    >
      {siteIcon(site.id)}
    </div>
  )
}

function AnimatedDropPreview({
  target,
}: {
  target: SiteRect
}) {
  const elementRef = useRef<HTMLDivElement>(null)
  const currentRef = useRef<SiteRect | null>(null)
  const { x, y, w, h } = target

  useLayoutEffect(() => {
    const element = elementRef.current
    if (!element || w <= 0 || h <= 0) return
    let frame: number | null = null
    let lastFrame = performance.now()
    const current = currentRef.current ?? {
      x: x + w * 0.025,
      y: y + h * 0.025,
      w: w * 0.95,
      h: h * 0.95,
    }
    currentRef.current = current

    const paint = () => {
      const scaleX = current.w / w
      const scaleY = current.h / h
      element.style.transform =
        `translate3d(${current.x}px, ${current.y}px, 0) scale(${scaleX}, ${scaleY})`
    }

    if (prefersReducedMotion()) {
      Object.assign(current, { x, y, w, h })
      element.style.opacity = "1"
      paint()
      return
    }

    element.style.willChange = "transform"
    element.style.opacity = "1"
    const tick = (now: number) => {
      const dt = Math.min(0.05, Math.max(0, (now - lastFrame) / 1000))
      lastFrame = now
      const rate = radAnimationRate(YAADE_RATE_MENU, dt)
      current.x = radLerp(current.x, x, rate)
      current.y = radLerp(current.y, y, rate)
      current.w = radLerp(current.w, w, rate)
      current.h = radLerp(current.h, h, rate)
      paint()

      const settled =
        Math.abs(current.x - x) < YAADE_LAYOUT_EPSILON &&
        Math.abs(current.y - y) < YAADE_LAYOUT_EPSILON &&
        Math.abs(current.w - w) < YAADE_LAYOUT_EPSILON &&
        Math.abs(current.h - h) < YAADE_LAYOUT_EPSILON
      if (settled) {
        Object.assign(current, { x, y, w, h })
        paint()
        element.style.willChange = "auto"
      } else {
        frame = requestAnimationFrame(tick)
      }
    }
    paint()
    frame = requestAnimationFrame(tick)
    return () => {
      if (frame != null) cancelAnimationFrame(frame)
      element.style.willChange = "auto"
    }
  }, [h, w, x, y])

  return (
    <div
      ref={elementRef}
      data-yaade-dock-preview=""
      className="pointer-events-none rounded-md border border-primary/60 bg-primary/10 opacity-0 shadow-sm ring-1 ring-primary/15 transition-opacity duration-[var(--yaade-motion-fast)] ease-[var(--yaade-ease-out)] before:absolute before:inset-x-2 before:top-2 before:h-px before:rounded-full before:bg-primary/40"
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: w,
        height: h,
        transformOrigin: "0 0",
        transform: `translate3d(${x + w * 0.025}px, ${y + h * 0.025}px, 0) scale(0.95)`,
      }}
    />
  )
}

export function PanelDropOverlay({ panelId }: { panelId: PanelId }) {
  const tabDrag = usePanelDragSource()
  const dropHot = useDropHot()
  const containerRef = useRef<HTMLDivElement>(null)
  const active = tabDrag != null
  const [entered, setEntered] = useState(false)
  // ResizeObserver only while a tab drag is active — idle N-pane docks pay zero measure cost.
  const size = useElementSize(containerRef, active)
  const fontSize = useFontSize(containerRef)
  const samePanel =
    tabDrag?.panelId != null && tabDrag.panelId.id === panelId.id

  const sites = useMemo(
    () => (active ? computeDropSites(size.w, size.h, fontSize) : []),
    [active, size.w, size.h, fontSize],
  )

  useEffect(() => {
    if (!active) {
      setEntered(false)
      return
    }
    if (prefersReducedMotion()) {
      setEntered(true)
      return
    }
    const frame = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(frame)
  }, [active])
  const effectiveSites = samePanel ? sites.filter(s => s.id !== "center") : sites

  const hotSite: DropSite | null =
    dropHot && dropHot.panelId.id === panelId.id
      ? (effectiveSites.find(s => s.id === dropHot.zone) ?? null)
      : null

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    if (active && effectiveSites.length > 0) {
      dropSitesRegistry.set(el, effectiveSites)
    } else {
      dropSitesRegistry.delete(el)
    }
  }, [active, effectiveSites, panelId.id])

  return (
    <div
      ref={containerRef}
      className={cn("absolute inset-0 z-40", !active && "pointer-events-none")}
      data-yaade-panel-drop-overlay
      data-yaade-drop-panel={panelId.id}
    >
      {active && (
        <>
          {hotSite && (
            <AnimatedDropPreview target={hotSite.preview} />
          )}

          {effectiveSites.map(site => (
            <DropSiteTarget
              key={site.id}
              panelId={panelId}
              site={site}
              entered={entered}
              hot={hotSite?.id === site.id}
            />
          ))}
        </>
      )}
    </div>
  )
}

export { siteToAction }
