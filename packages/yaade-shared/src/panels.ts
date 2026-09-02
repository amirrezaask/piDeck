/** Yaade-specific view union. Panels are tab stacks or empty. */
export type PanelView =
  | { kind: "empty" }
  | { kind: "tabs"; activeTabId: string; tabIds: string[] }

export type PanelId = { id: number }

export function panelId(id: number): PanelId {
  return { id }
}

export type Edge = "left" | "right" | "top" | "bottom" | "center"

export type DropAction =
  | { kind: "moveToPane"; insertIndex?: number }
  | { kind: "split"; edge: Edge }
  | { kind: "insertAtBoundary"; parentPath: number[]; beforeChild: number }

export const DRAG_KIND_TAB = 0x7ab
export const DRAG_KIND_PANEL = 0x9a4e
