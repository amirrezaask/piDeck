import type { GhosttyTerminalSurface } from "@yaade/ghostty-react"

type ResidentSurface = {
  readonly terminalId: string
  readonly mount: HTMLElement
  readonly home: HTMLElement
  readonly accessory?: HTMLElement
  readonly accessoryHome?: HTMLElement
  readonly surface: GhosttyTerminalSurface
  placement: HTMLElement | null
  generation: number
}

const residentSurfaces = new Map<string, ResidentSurface>()
const listeners = new Map<string, Set<() => void>>()

function setPanelPlaced(mount: HTMLElement, placed: boolean): void {
  const isPanel =
    mount.hasAttribute("data-yaade-terminal-panel") ||
    mount.hasAttribute("data-yaade-resident-terminal-panel")
  if (!isPanel) return
  mount.toggleAttribute("data-yaade-terminal-panel", placed)
  mount.toggleAttribute("data-yaade-resident-terminal-panel", !placed)
}

function notify(terminalId: string): void {
  for (const listener of listeners.get(terminalId) ?? []) listener()
}

export function registerResidentTerminalSurface(options: {
  readonly terminalId: string
  readonly mount: HTMLElement
  readonly home: HTMLElement
  readonly accessory?: HTMLElement
  readonly accessoryHome?: HTMLElement
  readonly surface: GhosttyTerminalSurface
}): () => void {
  const existing = residentSurfaces.get(options.terminalId)
  if (existing && existing.surface !== options.surface) {
    // A terminal ID has one active client surface. Dispose is owned by the
    // registering controller; never create a second placement owner silently.
    throw new Error(`terminal surface already registered: ${options.terminalId}`)
  }
  const resident: ResidentSurface = {
    ...options,
    placement: null,
    generation: 1,
  }
  residentSurfaces.set(options.terminalId, resident)
  setPanelPlaced(options.mount, false)
  options.home.append(options.mount)
  if (options.accessory && options.accessoryHome) {
    options.accessoryHome.append(options.accessory)
  }
  notify(options.terminalId)
  return () => {
    if (residentSurfaces.get(options.terminalId) !== resident) return
    residentSurfaces.delete(options.terminalId)
    resident.placement = null
    notify(options.terminalId)
  }
}

export function acquireTerminalSurfacePlacement(
  terminalId: string,
  slot: HTMLElement,
  visible = true,
): (() => void) | null {
  const resident = residentSurfaces.get(terminalId)
  if (!resident) return null
  const generation = ++resident.generation
  resident.placement = slot
  setPanelPlaced(resident.mount, true)
  slot.replaceChildren(
    resident.mount,
    ...(resident.accessory ? [resident.accessory] : []),
  )
  resident.surface.setVisible(visible)
  if (visible) resident.surface.ensureFitted()
  return () => {
    const current = residentSurfaces.get(terminalId)
    if (current !== resident || resident.generation !== generation) return
    resident.placement = null
    setPanelPlaced(resident.mount, false)
    resident.home.append(resident.mount)
    if (resident.accessory && resident.accessoryHome) {
      resident.accessoryHome.append(resident.accessory)
    }
    resident.surface.setVisible(false)
  }
}

export function subscribeResidentTerminalSurface(
  terminalId: string,
  listener: () => void,
): () => void {
  const set = listeners.get(terminalId) ?? new Set<() => void>()
  set.add(listener)
  listeners.set(terminalId, set)
  return () => {
    set.delete(listener)
    if (set.size === 0) listeners.delete(terminalId)
  }
}

export function readResidentTerminalSurfaceCount(): number {
  return residentSurfaces.size
}
