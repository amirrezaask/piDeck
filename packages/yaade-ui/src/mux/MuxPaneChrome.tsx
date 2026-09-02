import {
  Columns2,
  Maximize2,
  Minimize2,
  Rows2,
  X,
} from "lucide-react"
import { useDraggable } from "@dnd-kit/core"
import type { MouseEvent, ReactNode } from "react"
import type { PanelId } from "@yaade/shared"
import { Button } from "@/components/ui/button.js"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.js"
import { formatKeyBinding } from "@/lib/format-key.js"
import { cn } from "@/lib/utils.js"
import { tabDndId, type TabDragData } from "../dock/tab-dnd-types.js"

export type MuxPaneChromeProps = {
  title: string
  focused: boolean
  paneId: string
  panelId: PanelId
  zoomed: boolean
  canZoom: boolean
  /** Empty placeholders and other non-resident panes cannot be docked. */
  draggable?: boolean
  onSplitButton?: (
    direction: "right" | "down",
    event: MouseEvent<HTMLButtonElement>,
  ) => void
  /** Wrap a split control, for example with a terminal picker popover. */
  wrapSplitButton?: (
    direction: "right" | "down",
    button: ReactNode,
  ) => ReactNode
  onSplitRight: () => void
  onSplitDown: () => void
  onZoom: () => void
  onClose: () => void
  /**
   * Resolve a display shortcut for a command id (e.g. `mux.zoomPane` → `Mod-k z`).
   * App layer owns the binding table; UI must not import mux-keymap.
   */
  shortcutFor?: (commandId: string) => string | undefined
  className?: string
}

function SplitControl(props: {
  direction: "right" | "down"
  icon: ReactNode
  shortcut?: string
  onSplit: () => void
  onSplitButton?: (
    direction: "right" | "down",
    event: MouseEvent<HTMLButtonElement>,
  ) => void
  wrapSplitButton?: (
    direction: "right" | "down",
    button: ReactNode,
  ) => ReactNode
}) {
  const handleSplit = (event: MouseEvent<HTMLButtonElement>) => {
    if (props.onSplitButton) props.onSplitButton(props.direction, event)
    else props.onSplit()
  }
  const button = (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={props.direction === "right" ? "Split right" : "Split down"}
      title={
        props.shortcut
          ? `${props.direction === "right" ? "Split right" : "Split down"} (${formatKeyBinding(props.shortcut)})`
          : undefined
      }
      data-yaade-mux-split={props.direction}
      className="text-muted-foreground/55 opacity-60 hover:text-foreground hover:opacity-100 focus-visible:text-foreground focus-visible:opacity-100 group-hover/mux-chrome:opacity-100 group-focus-within/mux-chrome:opacity-100"
      onClick={handleSplit}
      onContextMenu={event => {
        if (!props.onSplitButton || (!event.metaKey && !event.ctrlKey)) return
        event.preventDefault()
        event.stopPropagation()
        handleSplit(event)
      }}
    >
      {props.icon}
    </Button>
  )
  return props.wrapSplitButton?.(props.direction, button) ?? button
}

export function MuxPaneChrome(props: MuxPaneChromeProps) {
  const {
    title,
    focused,
    paneId,
    panelId,
    zoomed,
    canZoom,
    draggable: draggableProp = true,
    onSplitButton,
    wrapSplitButton,
    onSplitRight,
    onSplitDown,
    onZoom,
    onClose,
    shortcutFor,
    className,
  } = props

  const draggable = draggableProp && !zoomed
  const {
    attributes,
    listeners,
    setNodeRef,
    isDragging,
  } = useDraggable({
    id: tabDndId(panelId, paneId),
    disabled: !draggable,
    data: {
      type: "tab",
      panelId,
      tabId: paneId,
      label: title,
    } satisfies TabDragData,
  })

  const splitRightShortcut = shortcutFor?.("mux.splitRight")
  const splitDownShortcut = shortcutFor?.("mux.splitDown")
  const zoomShortcut = shortcutFor?.("mux.zoomPane")
  const zoomLabel = zoomed ? "Restore pane" : "Zoom pane"
  const zoomTitle = zoomShortcut
    ? `${zoomed ? "Restore" : "Zoom"} (${formatKeyBinding(zoomShortcut)})`
    : zoomLabel

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={setNodeRef}
          data-yaade-mux-pane-chrome={paneId}
          data-yaade-pane-tab=""
          data-panel-id={panelId.id}
          data-focused={focused ? "" : undefined}
          data-zoomed={zoomed ? "" : undefined}
          data-dragging={isDragging ? "" : undefined}
          className={cn(
            "group/mux-chrome pointer-events-none absolute inset-x-0 top-0 z-20 h-0 min-h-0",
            isDragging && "opacity-30",
            className,
          )}
          {...(draggable ? listeners : {})}
          onDoubleClick={event => {
            const target = event.target
            if (target instanceof Element && target.closest("button")) return
            if (canZoom) onZoom()
          }}
        >
          <div
            aria-label={title || "Pane"}
            aria-roledescription={draggable ? "draggable pane tab" : undefined}
            title={draggable ? `${title || "Pane"} — drag to dock pane` : title || "Pane"}
            data-yaade-mux-pane-drag=""
            data-yaade-mux-pane-title=""
            className={cn(
              "pointer-events-auto absolute inset-x-0 top-0 h-8 opacity-0",
              draggable ? "cursor-grab touch-none active:cursor-grabbing" : "",
            )}
            {...(draggable ? attributes : {})}
          />
          <div
            className="pointer-events-auto absolute top-0 right-0 p-2"
            data-yaade-mux-pane-control-zone=""
          >
            <div
              className="pointer-events-none flex items-center gap-0.5"
              data-yaade-mux-pane-controls=""
              onPointerDown={event => event.stopPropagation()}
            >
              <SplitControl
                direction="right"
                icon={<Columns2 />}
                shortcut={splitRightShortcut}
                onSplit={onSplitRight}
                onSplitButton={onSplitButton}
                wrapSplitButton={wrapSplitButton}
              />
              <SplitControl
                direction="down"
                icon={<Rows2 />}
                shortcut={splitDownShortcut}
                onSplit={onSplitDown}
                onSplitButton={onSplitButton}
                wrapSplitButton={wrapSplitButton}
              />
              {canZoom ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={zoomLabel}
                  aria-pressed={zoomed}
                  title={zoomTitle}
                  data-yaade-mux-zoom=""
                  className="text-muted-foreground/55 opacity-60 hover:text-foreground hover:opacity-100 focus-visible:text-foreground focus-visible:opacity-100 group-hover/mux-chrome:opacity-100 group-focus-within/mux-chrome:opacity-100"
                  onClick={onZoom}
                >
                  {zoomed ? <Minimize2 /> : <Maximize2 />}
                </Button>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Close pane"
                title="Close pane"
                data-yaade-mux-close-pane=""
                className="text-muted-foreground/55 opacity-60 hover:text-foreground hover:opacity-100 focus-visible:text-foreground focus-visible:opacity-100 group-hover/mux-chrome:opacity-100 group-focus-within/mux-chrome:opacity-100"
                onClick={onClose}
              >
                <X />
              </Button>
            </div>
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent data-yaade-mux-pane-context-menu="">
        <ContextMenuItem onSelect={onSplitRight}>
          Split Right
          {splitRightShortcut ? (
            <ContextMenuShortcut>{formatKeyBinding(splitRightShortcut)}</ContextMenuShortcut>
          ) : null}
        </ContextMenuItem>
        <ContextMenuItem onSelect={onSplitDown}>
          Split Down
          {splitDownShortcut ? (
            <ContextMenuShortcut>{formatKeyBinding(splitDownShortcut)}</ContextMenuShortcut>
          ) : null}
        </ContextMenuItem>
        {canZoom ? (
          <ContextMenuItem onSelect={onZoom}>
            {zoomed ? "Restore Pane" : "Zoom Pane"}
            {zoomShortcut ? (
              <ContextMenuShortcut>{formatKeyBinding(zoomShortcut)}</ContextMenuShortcut>
            ) : null}
          </ContextMenuItem>
        ) : null}
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onSelect={onClose}>
          Close Pane
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
