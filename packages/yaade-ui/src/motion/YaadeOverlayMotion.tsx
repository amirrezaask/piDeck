import { GripVertical } from "lucide-react"
import { cn } from "@/lib/utils.js"
import { useReducedMotion } from "./useReducedMotion.js"

export function YaadeTabDragGhost({
  label,
  dirty,
  className,
}: {
  label: string
  dirty?: boolean
  className?: string
}) {
  const reduced = useReducedMotion()

  return (
    <div
      data-yaade-tab-drag-ghost
      className={cn(
        "pointer-events-none inline-flex h-8 w-max max-w-64 -translate-y-10 translate-x-2 select-none items-center gap-1.5 rounded-md border border-primary/40 bg-popover px-2 text-xs text-popover-foreground shadow-lg",
        !reduced && "rotate-[0.75deg] scale-[1.02] transform-gpu will-change-transform",
        className,
      )}
    >
      <GripVertical className="size-3 shrink-0 text-muted-foreground" aria-hidden />
      <span className="truncate font-medium">{label}</span>
      {dirty ? (
        <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-label="Unsaved changes" />
      ) : null}
    </div>
  )
}
