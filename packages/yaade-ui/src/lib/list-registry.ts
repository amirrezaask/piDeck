/** Registry of scroll-container refs + live controllers for list-style panels. */

const containers = new Map<string, HTMLElement>()
const controllers = new Map<string, ListPanelController>()

const LIST_ITEM_SELECTOR = "[data-yaade-list-item]"

export type ListFocusAction =
  | "focusNext"
  | "focusPrev"
  | "focusFirstItem"
  | "focusLastItem"
  | "activate"
  | "focusPageUp"
  | "focusPageDown"
  | "focusFirst"
  | "focusLast"

export function registerListPanel(listId: string, el: HTMLElement | null): () => void {
  if (!el) return () => {}
  containers.set(listId, el)
  return () => {
    if (containers.get(listId) === el) containers.delete(listId)
  }
}

/** Live navigation API (preferred over DOM scan — works with virtualized lists). */
export function registerListPanelController(
  listId: string,
  controller: ListPanelController | null,
): () => void {
  if (!controller) return () => {}
  controllers.set(listId, controller)
  return () => {
    if (controllers.get(listId) === controller) controllers.delete(listId)
  }
}

export function getListPanel(listId: string): HTMLElement | null {
  return containers.get(listId) ?? null
}

export function getListItems(listId: string): HTMLElement[] {
  const el = getListPanel(listId)
  if (!el) return []
  return [...el.querySelectorAll<HTMLElement>(LIST_ITEM_SELECTOR)]
}

export function focusListPanel(listId: string, action: ListFocusAction): boolean {
  const live = controllers.get(listId)
  if (live) {
    switch (action) {
      case "focusNext":
        live.focusNext()
        return true
      case "focusPrev":
        live.focusPrev()
        return true
      case "focusFirstItem":
        live.focusFirstItem()
        return true
      case "focusLastItem":
        live.focusLastItem()
        return true
      case "activate":
        live.activate()
        return true
      case "focusPageUp":
        live.focusPageUp()
        return true
      case "focusPageDown":
        live.focusPageDown()
        return true
      case "focusFirst":
        live.focusFirst()
        return true
      case "focusLast":
        live.focusLast()
        return true
      default:
        return false
    }
  }

  const el = getListPanel(listId)
  if (!el) return false
  const items = getListItems(listId)
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null

  const focusItem = (index: number) => {
    const next = items[Math.max(0, Math.min(items.length - 1, index))]
    next?.focus()
  }

  switch (action) {
    case "focusNext":
      focusItem((active && items.includes(active) ? items.indexOf(active) : -1) + 1)
      return true
    case "focusPrev":
      focusItem((active && items.includes(active) ? items.indexOf(active) : items.length) - 1)
      return true
    case "focusFirstItem":
      focusItem(0)
      return true
    case "focusLastItem":
      focusItem(items.length - 1)
      return true
    case "activate":
      active?.click()
      return true
    case "focusPageUp": {
      const page = Math.max(80, Math.floor(el.clientHeight * 0.85))
      el.scrollBy({ top: -page })
      return true
    }
    case "focusPageDown": {
      const page = Math.max(80, Math.floor(el.clientHeight * 0.85))
      el.scrollBy({ top: page })
      return true
    }
    case "focusFirst":
      el.scrollTop = 0
      return true
    case "focusLast":
      el.scrollTop = el.scrollHeight
      return true
    default:
      return false
  }
}

export function focusFirstListItem(listId: string): boolean {
  const live = controllers.get(listId)
  if (live) {
    live.focusFirstItem()
    return true
  }
  const el = getListPanel(listId)
  if (!el) return false
  const first = el.querySelector<HTMLElement>(LIST_ITEM_SELECTOR)
  ;(first ?? el).focus()
  return true
}

/** Imperative navigation API for a registered list panel. */
export type ListPanelController = {
  focusNext: () => void
  focusPrev: () => void
  activate: () => void
  focusFirstItem: () => void
  focusLastItem: () => void
  focusPageUp: () => void
  focusPageDown: () => void
  focusFirst: () => void
  focusLast: () => void
}

export function getListPanelController(listId: string): ListPanelController | null {
  const live = controllers.get(listId)
  if (live) return live
  if (!getListPanel(listId)) return null
  return {
    focusNext: () => {
      focusListPanel(listId, "focusNext")
    },
    focusPrev: () => {
      focusListPanel(listId, "focusPrev")
    },
    activate: () => {
      focusListPanel(listId, "activate")
    },
    focusFirstItem: () => {
      focusListPanel(listId, "focusFirstItem")
    },
    focusLastItem: () => {
      focusListPanel(listId, "focusLastItem")
    },
    focusPageUp: () => {
      focusListPanel(listId, "focusPageUp")
    },
    focusPageDown: () => {
      focusListPanel(listId, "focusPageDown")
    },
    focusFirst: () => {
      focusListPanel(listId, "focusFirst")
    },
    focusLast: () => {
      focusListPanel(listId, "focusLast")
    },
  }
}
