import { useDraggable, useDroppable } from "@dnd-kit/core";
import { GripVertical } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/lib/utils.js";
import { sessionDndId, sessionTabDropDndId, type SessionDragData } from "./tab-dnd-types.js";

export type DockSourceHandleProps = {
  readonly tabId: string;
  readonly label: string;
  readonly className?: string;
};

export type DockSourceOptions = {
  readonly tabId: string;
  readonly label: string;
  readonly sourceId?: string;
  readonly disabled?: boolean;
};

/** Bind any app-owned tab surface to the shared pane-docking drag system. */
export function useDockSource(options: DockSourceOptions) {
  const data: SessionDragData = {
    type: "session",
    tabId: options.tabId,
    label: options.label,
  };
  if (options.sourceId) data.sourceId = options.sourceId;
  return useDraggable({
    id: sessionDndId(options.sourceId ? `${options.sourceId}:${options.tabId}` : options.tabId),
    disabled: options.disabled,
    data,
  });
}

/** Register a source-strip item as a reorder destination for dockable tabs. */
export function useDockReorderTarget(sourceId: string) {
  return useDroppable({ id: sessionTabDropDndId(sourceId) });
}

/** Drag a resident sidebar/tab item into a PanelDock without moving its source. */
export function DockSourceHandle(props: DockSourceHandleProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDockSource(props);

  return (
    <Button
      ref={setNodeRef}
      type="button"
      size="icon-xs"
      variant="ghost"
      aria-label={`Drag ${props.label} to dock pane`}
      title="Drag to dock pane"
      data-yaade-dock-source={props.tabId}
      data-dragging={isDragging ? "" : undefined}
      className={cn(
        "shrink-0 touch-none cursor-grab text-muted-foreground opacity-0 transition-[opacity,transform] duration-[var(--yaade-motion-fast)] ease-[var(--yaade-ease-out)] active:cursor-grabbing group-hover:opacity-70 group-focus-within:opacity-70 focus-visible:opacity-100 data-[dragging]:scale-95 data-[dragging]:opacity-30",
        props.className,
      )}
      onClick={(event) => event.stopPropagation()}
      {...attributes}
      {...listeners}
    >
      <GripVertical />
    </Button>
  );
}
