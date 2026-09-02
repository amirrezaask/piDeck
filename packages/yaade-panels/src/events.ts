import type { DropAction, PanelId } from "@yaade/shared"

export type PanelEvent =
  | { type: "splitRatiosChanged"; path: number[]; ratios: number[] }
  | { type: "panelClose"; panelId: PanelId }
  | { type: "tabDrop"; source: PanelId; sourceTabId: string; target: PanelId; action: DropAction }
  | { type: "tabReorder"; panelId: PanelId; tabId: string; toIndex: number }
  | { type: "tabActivate"; panelId: PanelId; tabId: string }
  | { type: "tabClose"; panelId: PanelId; tabId: string }
