import { Fragment, useMemo, type ReactNode } from "react"
import { LayoutGroup, LazyMotion, MotionConfig } from "motion/react"
import { div as MotionDiv } from "motion/react-m"
import type { PanelEvent, PanelNode } from "@yaade/panels"
import type { PanelTree } from "@yaade/panels"
import type { PanelId } from "@yaade/shared"
import type { Layout } from "react-resizable-panels"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable.js"
import { cn } from "@/lib/utils.js"
import { yaadeMotion } from "@/motion/tokens.js"
import { usePanelDragSource } from "./PanelDragContext.js"
import { PanelDropOverlay } from "./PanelDropOverlay.js"
import { TabDndRoot, useDropHot, type TabDndHandlers } from "./TabDndRoot.js"

const loadMotionFeatures = () => import("motion/react").then(({ domMax }) => domMax)

export type PanelSlotMeta = {
  focused: boolean
  onClose: () => void
}

export type PanelDockProps<TView> = {
  tree: PanelTree<TView>
  focusedPanelId: PanelId | null
  onFocusPanel: (id: PanelId) => void
  onEvent: (event: PanelEvent) => void
  /** Handlers used by the default `PanelDock` DnD boundary. */
  tabDnd: TabDndHandlers
  /** Optional visual treatment for every leaf in this dock. */
  leafClassName?: string
  renderHeader: (view: TView, panelId: PanelId, meta: PanelSlotMeta) => ReactNode
  renderContent: (view: TView, panelId: PanelId, meta: PanelSlotMeta) => ReactNode
}

/** Props for a dock rendered inside an existing `TabDndRoot`. */
export type PanelDockInDndProps<TView> = Omit<PanelDockProps<TView>, "tabDnd">

function splitPanelDomId(path: number[], index: number): string {
  return path.length === 0 ? `yaade-split-${index}` : `yaade-split-${path.join(".")}-${index}`
}

function splitGroupDomId(path: number[]): string {
  return path.length === 0 ? "yaade-root-split" : `yaade-split-group-${path.join(".")}`
}

function PanelLeaf<TView>({
  panelId,
  view,
  focused,
  onFocusPanel,
  onEvent,
  renderHeader,
  renderContent,
  leafClassName,
}: {
  panelId: PanelId
  view: TView
  focused: boolean
  onFocusPanel: (id: PanelId) => void
  onEvent: (event: PanelEvent) => void
  renderHeader: PanelDockProps<TView>["renderHeader"]
  renderContent: PanelDockProps<TView>["renderContent"]
  leafClassName?: string
}) {
  const tabDrag = usePanelDragSource()
  const dropHot = useDropHot()
  const onClose = () => onEvent({ type: "panelClose", panelId })
  const meta: PanelSlotMeta = { focused, onClose }
  const isHotDropTarget =
    tabDrag != null && dropHot?.panelId.id === panelId.id

  return (
    <MotionDiv
      layout
      initial={{ opacity: 0, scale: 0.985 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{
        layout: yaadeMotion.dockLayoutTransition,
        opacity: yaadeMotion.quickFade,
        scale: yaadeMotion.layoutTransition,
      }}
      className={cn(
        "relative flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden transition-[border-color,box-shadow] duration-[var(--yaade-motion-fast)] ease-[var(--yaade-ease-out)]",
        "rounded-lg border border-border bg-card",
        isHotDropTarget ? "ring-1 ring-primary/40" : "",
        leafClassName,
      )}
      data-yaade-panel-leaf={panelId.id}
      data-yaade-session-window=""
      data-focused={focused ? "" : undefined}
      data-yaade-panel-dragged-over={isHotDropTarget ? "" : undefined}
      onPointerDownCapture={() => onFocusPanel(panelId)}
    >
      {renderHeader(view, panelId, meta)}
      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        {renderContent(view, panelId, meta)}
      </div>
      <PanelDropOverlay panelId={panelId} />
    </MotionDiv>
  )
}

function PanelSplitNode<TView>({
  node,
  path,
  props,
}: {
  node: Extract<PanelNode<TView>, { kind: "row" | "column" }>
  path: number[]
  props: PanelDockInDndProps<TView>
}) {
  const orientation = node.kind === "row" ? "horizontal" : "vertical"
  const { children, ratios } = node.split

  const defaultLayout = useMemo(() => {
    const layout: Layout = {}
    children.forEach((_, index) => {
      layout[splitPanelDomId(path, index)] = ratios[index]! * 100
    })
    return layout
  }, [children, path, ratios])

  return (
    <ResizablePanelGroup
      key={splitGroupDomId(path)}
      id={splitGroupDomId(path)}
      orientation={orientation}
      defaultLayout={defaultLayout}
      className="h-full w-full gap-0"
      onLayoutChanged={(layout, meta) => {
        // Library already defers pointer-drag commits until release; skip
        // mount/constraint recomputes so MuxApp does not clone the tree.
        if (!meta.isUserInteraction) return
        const nextRatios = children.map(
          (_, index) => (layout[splitPanelDomId(path, index)] ?? ratios[index]! * 100) / 100,
        )
        const changed = nextRatios.some(
          (ratio, index) => Math.abs(ratio - ratios[index]!) > 0.005,
        )
        if (!changed) return
        props.onEvent({ type: "splitRatiosChanged", path, ratios: nextRatios })
      }}
    >
      {children.map((child, index) => (
        <Fragment key={splitPanelDomId(path, index)}>
          {index > 0 ? (
            <ResizableHandle
              orientation={orientation}
              data-yaade-pane-separator=""
              className="bg-transparent after:absolute after:bg-border/70 hover:after:bg-primary/60 data-[orientation=horizontal]:after:inset-y-0 data-[orientation=horizontal]:after:w-px data-[orientation=vertical]:after:inset-x-0 data-[orientation=vertical]:after:h-px"
              aria-label={
                orientation === "horizontal"
                  ? "Resize panes horizontally"
                  : "Resize panes vertically"
              }
              onDoubleClick={() => {
                const equal = children.map(() => 1 / children.length)
                props.onEvent({ type: "splitRatiosChanged", path, ratios: equal })
              }}
            />
          ) : null}
          <ResizablePanel
            id={splitPanelDomId(path, index)}
            defaultSize={`${ratios[index]! * 100}`}
            minSize="8"
            className="min-h-0 min-w-0"
          >
            <PanelTreeNode node={child} path={[...path, index]} props={props} />
          </ResizablePanel>
        </Fragment>
      ))}
    </ResizablePanelGroup>
  )
}

function PanelTreeNode<TView>({
  node,
  path,
  props,
}: {
  node: PanelNode<TView>
  path: number[]
  props: PanelDockInDndProps<TView>
}) {
  if (node.kind === "leaf") {
    const focused = props.focusedPanelId?.id === node.panelId.id
    return (
      <div className="flex h-full min-h-0 w-full flex-1 flex-col">
        <PanelLeaf
          panelId={node.panelId}
          view={node.view}
          focused={focused}
          onFocusPanel={props.onFocusPanel}
          onEvent={props.onEvent}
          renderHeader={props.renderHeader}
          renderContent={props.renderContent}
          leafClassName={props.leafClassName}
        />
      </div>
    )
  }
  return <PanelSplitNode node={node} path={path} props={props} />
}

function PanelDockInner<TView>(props: PanelDockInDndProps<TView>) {
  const dock = (
    <LazyMotion features={loadMotionFeatures}>
      <MotionConfig reducedMotion="user">
        <LayoutGroup id="yaade-panel-dock">
          <div className="flex h-full min-h-0 w-full flex-col overflow-hidden" data-yaade-panel-dock>
            <PanelTreeNode node={props.tree.root} path={[]} props={props} />
          </div>
        </LayoutGroup>
      </MotionConfig>
    </LazyMotion>
  )
  return dock
}

function PanelDockWithDnd<TView>(props: PanelDockProps<TView>) {
  const { tabDnd, ...dockProps } = props
  return (
    <TabDndRoot handlers={tabDnd}>
      <PanelDockInner {...dockProps} />
    </TabDndRoot>
  )
}

/** Self-contained dock that owns its `TabDndRoot`. */
export function PanelDock<TView>(props: PanelDockProps<TView>): ReactNode {
  return <PanelDockWithDnd {...props} />
}

/** Dock layout for callers that already provide the surrounding DnD context. */
export function PanelDockInDnd<TView>(props: PanelDockInDndProps<TView>): ReactNode {
  return <PanelDockInner {...props} />
}
