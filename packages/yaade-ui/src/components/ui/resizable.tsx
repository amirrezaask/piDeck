import { GripHorizontalIcon, GripVerticalIcon } from "lucide-react"
import { Group, Panel, Separator, type Layout, type Orientation } from "react-resizable-panels"

import { cn } from "@/lib/utils"

function ResizablePanelGroup({
  className,
  orientation = "horizontal",
  ...props
}: React.ComponentProps<typeof Group> & { orientation?: Orientation }) {
  return (
    <Group
      data-slot="resizable-panel-group"
      orientation={orientation}
      className={cn(
        "flex h-full w-full bg-transparent data-[orientation=vertical]:flex-col",
        className,
      )}
      {...props}
    />
  )
}

const ResizablePanel = Panel

function ResizableHandle({
  withHandle,
  orientation = "horizontal",
  className,
  ...props
}: React.ComponentProps<typeof Separator> & {
  withHandle?: boolean
  /** Orientation of the panel group this separator divides. */
  orientation?: Orientation
}) {
  const vertical = orientation === "vertical"
  const GripIcon = vertical ? GripHorizontalIcon : GripVerticalIcon

  return (
    <Separator
      data-slot="resizable-handle"
      data-orientation={orientation}
      className={cn(
        "relative z-10 flex shrink-0 items-center justify-center bg-border/80 transition-[background-color,box-shadow] duration-[var(--yaade-motion-fast)] ease-[var(--yaade-ease-out)] hover:bg-primary/60 data-[separator=active]:bg-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1",
        vertical
          ? "h-1.5 w-full cursor-row-resize"
          : "h-full w-1.5 cursor-col-resize",
        className,
      )}
      {...props}
    >
      {withHandle ? (
        <div className="z-10 flex h-4 w-3 items-center justify-center rounded-sm border bg-border">
          <GripIcon className="size-2.5" />
        </div>
      ) : null}
    </Separator>
  )
}

export { ResizablePanelGroup, ResizablePanel, ResizableHandle, type Layout, type Orientation }
