import {
  createContext,
  use,
  useCallback,
  useMemo,
  useState,
  type ReactNode,
} from "react"
import type { PanelId } from "@yaade/shared"

/** `panelId` is null when the drag starts from the session sidebar (not yet in a pane). */
export type TabDragSource = { panelId: PanelId | null; tabId: string }

type PanelDragActions = {
  startTab: (src: TabDragSource) => void
  endTab: () => void
}

// Drag state changes at pointer interaction frequency. Keep it separate from
// the stable actions context so the DnD coordinator does not re-render when a
// panel only needs to start or end a drag.
const TabDragSourceContext = createContext<TabDragSource | null | undefined>(undefined)
const PanelDragActionsContext = createContext<PanelDragActions | null>(null)

export function PanelDragProvider({ children }: { children: ReactNode }) {
  const [tabSource, setTabSource] = useState<TabDragSource | null>(null)
  const startTab = useCallback((src: TabDragSource) => setTabSource(src), [])
  const endTab = useCallback(() => setTabSource(null), [])
  const actions = useMemo<PanelDragActions>(
    () => ({ startTab, endTab }),
    [endTab, startTab],
  )

  return (
    <PanelDragActionsContext.Provider value={actions}>
      <TabDragSourceContext.Provider value={tabSource}>
        {children}
      </TabDragSourceContext.Provider>
    </PanelDragActionsContext.Provider>
  )
}

export function usePanelDragSource(): TabDragSource | null {
  const source = use(TabDragSourceContext)
  if (source === undefined) {
    throw new Error("usePanelDragSource must be inside PanelDragProvider")
  }
  return source
}

export function usePanelDragActions(): PanelDragActions {
  const actions = use(PanelDragActionsContext)
  if (!actions) {
    throw new Error("usePanelDragActions must be inside PanelDragProvider")
  }
  return actions
}
