import type { HTMLAttributes, ReactNode, Ref } from "react"
import { cn } from "../lib/utils.js"

export type SidebarShellProps = {
  "aria-label": string
  children: ReactNode
  header?: ReactNode
  footer?: ReactNode
  contentAs?: "div" | "nav"
  contentClassName?: string
  contentProps?: HTMLAttributes<HTMLElement> & Record<string, unknown>
  contentRef?: Ref<HTMLElement>
  headerClassName?: string
  footerClassName?: string
  dataAttributes?: Record<string, string | undefined>
  className?: string
}

/** Shared Changes-style frame for every navigational sidebar. */
export function SidebarShell({
  "aria-label": ariaLabel,
  children,
  header,
  footer,
  contentAs = "div",
  contentClassName,
  contentProps,
  contentRef,
  headerClassName,
  footerClassName,
  dataAttributes,
  className,
}: SidebarShellProps) {
  const {
    className: providedContentClassName,
    ...restContentProps
  } = contentProps ?? {}
  const contentClass = cn(
    "min-h-0 flex-1 overflow-auto",
    contentClassName,
    providedContentClassName,
  )

  const content = contentAs === "nav" ? (
    <nav
      {...restContentProps}
      ref={contentRef as Ref<HTMLElement>}
      className={contentClass}
    >
      {children}
    </nav>
  ) : (
    <div
      {...restContentProps}
      ref={contentRef as Ref<HTMLDivElement>}
      className={contentClass}
    >
      {children}
    </div>
  )

  return (
    <aside
      {...dataAttributes}
      data-yaade-sidebar-shell=""
      className={cn(
        "flex h-full min-h-0 min-w-0 flex-col overflow-hidden border-r border-border/40 bg-card",
        className,
      )}
      aria-label={ariaLabel}
    >
      {header ? (
        <div
          className={cn(
            "flex shrink-0 items-center gap-2 border-b border-border/40 p-2",
            headerClassName,
          )}
        >
          {header}
        </div>
      ) : null}
      {content}
      {footer ? (
        <div
          className={cn(
            "shrink-0 border-t border-border/40 p-2",
            footerClassName,
          )}
        >
          {footer}
        </div>
      ) : null}
    </aside>
  )
}
