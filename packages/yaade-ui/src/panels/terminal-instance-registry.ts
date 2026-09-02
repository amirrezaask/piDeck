import type {
  GhosttyTerminalLifecycleSnapshot,
  GhosttyTerminalSurface,
} from "@yaade/ghostty-react"

const instances = new Map<string, GhosttyTerminalSurface>()

export function registerTerminalInstance(tabId: string, terminal: GhosttyTerminalSurface): void {
  instances.set(tabId, terminal)
}

export function getRegisteredTerminal(tabId: string): GhosttyTerminalSurface | undefined {
  return instances.get(tabId)
}

export function unregisterTerminalInstance(
  tabId: string,
  terminal?: GhosttyTerminalSurface,
): void {
  if (terminal && instances.get(tabId) !== terminal) return
  instances.delete(tabId)
}

function resolveTerminal(tabId?: string): GhosttyTerminalSurface | undefined {
  if (tabId) {
    const exact = instances.get(tabId)
    if (exact) return exact
  }

  // Mux keeps off-screen terminals mounted so their PTYs survive retile/LRU
  // changes. Prefer the focused, measurable panel; otherwise a hidden
  // zero-sized panel can satisfy the selector and make test reads look blank
  // while the visible canvas is rendering a different surface.
  const panels = [
    ...document.querySelectorAll<HTMLElement>(
      '[data-yaade-terminal-panel][data-yaade-terminal-status="running"]',
    ),
  ]
  const running =
    panels.find(panel => panel.closest("[data-focused]")) ??
    panels.find(panel => {
      const rect = panel.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    }) ??
    panels[0]
  const fromDom = running?.dataset.yaadeTerminalTabId
  if (fromDom && instances.has(fromDom)) return instances.get(fromDom)
  const last = [...instances.values()]
  return last[last.length - 1]
}

/** Buffer-backed terminal text for E2E / test bridge. */
export function readTerminalBufferText(tabId?: string): string {
  const ghostty = resolveTerminal(tabId)?.getBufferText() ?? ""
  if (ghostty.trim().length > 0) return ghostty
  const root = tabId
    ? document.querySelector(
        `[data-yaade-terminal-tab-id="${CSS.escape(tabId)}"] [data-yaade-terminal-semantic]`,
      )
    : document.querySelector("[data-yaade-terminal-semantic]")
  return root?.textContent ?? ghostty
}

export function readTerminalLifecycle(
  tabId?: string,
): GhosttyTerminalLifecycleSnapshot | null {
  return resolveTerminal(tabId)?.lifecycleSnapshot() ?? null
}

/** Advance only the idle-policy clock for deterministic browser memory gates. */
export function maintainTerminalIdleCapacity(tabId?: string): boolean {
  const terminal = resolveTerminal(tabId)
  if (!terminal) return false
  const idleAt = performance.now() + 120_000
  return terminal.maintainIdleCapacity(idleAt) || terminal.maintainIdleCapacity(idleAt + 120_000)
}

export function readTerminalPixelStats(tabId?: string) {
  return resolveTerminal(tabId)?.capturePixelStats() ?? Promise.resolve(null)
}

export function readTerminalDims(
  tabId?: string,
): { cols: number; rows: number } | null {
  const terminal = resolveTerminal(tabId)
  if (!terminal) return null
  const snapshot = terminal.getSnapshot()
  if (!snapshot) return null
  return { cols: snapshot.cols, rows: snapshot.rows }
}

/** Absolute viewport offset in Ghostty's scrollback model. */
export function readTerminalViewportY(tabId?: string): number | null {
  return resolveTerminal(tabId)?.getViewportY() ?? null
}

/** Scroll the active terminal by N lines (E2E / test). */
export function scrollTerminalLines(amount: number, tabId?: string): boolean {
  const terminal = resolveTerminal(tabId)
  if (!terminal || !Number.isFinite(amount) || amount === 0) return false
  terminal.scrollLines(amount)
  return true
}

export function readTerminalViewportActivity(tabId?: string): {
  readonly mode: "live" | "inspecting" | "paused"
  readonly canPause: boolean
} | null {
  const terminal = resolveTerminal(tabId)
  if (!terminal) return null
  return {
    mode: terminal.getViewportActivity().mode,
    canPause: terminal.canToggleInspectionPause(),
  }
}

export function jumpRegisteredTerminalToLive(tabId?: string): boolean {
  const terminal = resolveTerminal(tabId)
  if (!terminal) return false
  terminal.jumpToLive()
  return true
}

export function toggleRegisteredTerminalInspectionPause(tabId?: string): boolean {
  const terminal = resolveTerminal(tabId)
  if (!terminal || !terminal.canToggleInspectionPause()) return false
  terminal.toggleInspectionPause()
  return true
}

/** Focus the active terminal via its hidden IME input. */
export function focusRegisteredTerminal(tabId?: string): boolean {
  const terminal = resolveTerminal(tabId)
  if (!terminal) return false
  terminal.focus()
  return true
}

/** Apply a one-shot modifier to the next accessory or software-keyboard key. */
export function setTerminalVirtualModifier(
  modifier: "ctrl" | "alt",
  active: boolean,
  tabId?: string,
): boolean {
  const terminal = resolveTerminal(tabId)
  if (!terminal) return false
  terminal.setVirtualModifier(modifier, active)
  return true
}

/** Send a named key through Ghostty's active keyboard protocol encoder. */
export function sendTerminalVirtualKey(
  key: string,
  code: string,
  tabId?: string,
): boolean {
  const terminal = resolveTerminal(tabId)
  if (!terminal) return false
  terminal.sendVirtualKey(key, code)
  return true
}

/** Paste clipboard text with bracketed-paste encoding when enabled by the PTY. */
export async function pasteIntoRegisteredTerminal(tabId?: string): Promise<boolean> {
  const terminal = resolveTerminal(tabId)
  const clipboard = navigator.clipboard
  if (!terminal || !clipboard?.readText) return false
  const text = await clipboard.readText()
  if (text.length === 0) return false
  terminal.pasteText(text)
  return true
}

export function readTerminalCursor(
  tabId?: string,
): { x: number; y: number; hidden: boolean } | null {
  const snapshot = resolveTerminal(tabId)?.getSnapshot()
  if (!snapshot) return null
  return {
    x: snapshot.cursorX,
    y: snapshot.cursorY,
    hidden: !snapshot.cursorVisible,
  }
}

/** Locate visible needle for E2E click/hover (viewport-relative row). */
export function findTerminalBufferMatch(
  needle: string,
  tabId?: string,
): {
  col: number
  viewportRow: number
  cols: number
  rows: number
} | null {
  const snapshot = resolveTerminal(tabId)?.getSnapshot()
  if (!snapshot || !needle) return null

  for (let rowIndex = snapshot.rowData.length - 1; rowIndex >= 0; rowIndex -= 1) {
    const row = snapshot.rowData[rowIndex]
    if (!row) continue
    const text = row.cells.map(cell => cell.text || " ").join("")
    const textOffset = text.indexOf(needle)
    if (textOffset < 0) continue

    let offset = 0
    let col = 0
    for (let cellIndex = 0; cellIndex < row.cells.length; cellIndex += 1) {
      const cellText = row.cells[cellIndex]?.text || " "
      if (textOffset < offset + cellText.length) {
        col = cellIndex
        break
      }
      offset += cellText.length
      col = cellIndex
    }
    return {
      col,
      viewportRow: rowIndex,
      cols: snapshot.cols,
      rows: snapshot.rows,
    }
  }
  return null
}

/** Cell width/height in CSS px from the active renderer (E2E hit-testing). */
export function readTerminalCellSize(
  tabId?: string,
): { width: number; height: number } | null {
  return resolveTerminal(tabId)?.getCellSize() ?? null
}

/** Cell height in CSS px from the active renderer, or 0 when unavailable. */
export function readTerminalCellHeight(tabId?: string): number {
  return readTerminalCellSize(tabId)?.height ?? 0
}
