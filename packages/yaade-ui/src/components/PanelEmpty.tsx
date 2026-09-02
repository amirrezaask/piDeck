import type { ReactNode } from "react"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty.js"

export function PanelEmpty({
  title,
  description,
  action,
  compact = false,
}: {
  title: string
  description?: string
  action?: ReactNode
  compact?: boolean
}) {
  return (
    <Empty className={compact ? "border-0 px-3 py-4" : "h-full border-0 px-4 py-8"}>
      <EmptyHeader>
        <EmptyTitle className="text-sm">{title}</EmptyTitle>
        {description ? (
          <EmptyDescription className="text-xs">{description}</EmptyDescription>
        ) : null}
      </EmptyHeader>
      {action ? <EmptyContent>{action}</EmptyContent> : null}
    </Empty>
  )
}
