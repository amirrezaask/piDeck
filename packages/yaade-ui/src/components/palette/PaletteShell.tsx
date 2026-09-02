import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js"
import { COMMAND_SHELL_CLASS } from "@/lib/command-shell.js"
import { Lister, type ListerNode } from "@/lister/index.js"
import {
  PALETTE_LISTER_CHROME_PX,
  readPaletteRowHeight,
  readPaletteSizeMinWidthPx,
  type PaletteRowLayout,
} from "@/lister/measure.js"
import { cn } from "@/lib/utils.js"

export interface PaletteShellItem<T> {
  key: string
  value: string
  data: T
}

export interface PaletteShellProps<T> {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  placeholder: string
  disabled?: boolean
  query?: string
  onQueryChange?: (query: string) => void
  items: PaletteShellItem<T>[]
  onSelect: (item: T, query: string) => void
  onHighlightChange?: (item: T | null) => void
  isItemDisabled?: (item: T) => boolean
  renderItem: (item: T, query: string) => ReactNode
  emptyLabel: ReactNode
  statusRow?: ReactNode
  /** Optional adjacent detail/action pane. */
  sidecar?: ReactNode
  shouldFilter?: boolean
  /** Allow keyboard selection before the user types a query. */
  requireQueryForSelection?: boolean
  size?: "picker" | "wide"
  /**
   * Grow dialog width to fit longest visible item (capped by viewport).
   * Default on — lister reports preferred content width via measure helpers.
   */
  fitContent?: boolean
  /** Measure item labels with mono font (file paths). */
  contentWidthMono?: boolean
  /** Extra chrome beyond default palette row padding/icon. */
  contentWidthChromePx?: number
  contentClassName?: string
  itemClassName?: string
  itemStyle?: (item: T) => CSSProperties | undefined
  /** Single-line rows stay compact; detail rows reserve title + metadata line boxes. */
  rowLayout?: PaletteRowLayout
  /** Virtual row height in CSS pixels. Defaults to the compact single-line palette contract. */
  estimateSize?: (item: T) => number
  /** Stable surface identifier for scoped runtime and Playwright checks. */
  surface?: string
}

export function PaletteShell<T>({
  open,
  onOpenChange,
  title,
  description,
  placeholder,
  disabled,
  query: queryProp,
  onQueryChange,
  items,
  onSelect,
  onHighlightChange,
  isItemDisabled,
  renderItem,
  emptyLabel,
  statusRow,
  sidecar,
  shouldFilter,
  requireQueryForSelection = true,
  size = "picker",
  fitContent = true,
  contentWidthMono = false,
  contentWidthChromePx = PALETTE_LISTER_CHROME_PX,
  contentClassName,
  itemClassName,
  itemStyle,
  rowLayout = "single",
  estimateSize,
  surface,
}: PaletteShellProps<T>) {
  const isControlled = queryProp !== undefined
  const [uncontrolledQuery, setUncontrolledQuery] = useState("")
  const query = isControlled ? queryProp : uncontrolledQuery
  const setQuery = (next: string) => {
    if (!isControlled) setUncontrolledQuery(next)
    onQueryChange?.(next)
  }

  const [contentWidthPx, setContentWidthPx] = useState(0)
  const contentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open && !isControlled) setUncontrolledQuery("")
    if (!open) setContentWidthPx(0)
  }, [open, isControlled])

  useEffect(() => {
    if (!open) return
    const animationFrame = requestAnimationFrame(() => {
      contentRef.current
        ?.querySelector<HTMLInputElement>('[data-slot="command-input"]')
        ?.focus()
    })
    return () => cancelAnimationFrame(animationFrame)
  }, [open])

  const onContentWidthChange = useCallback((widthPx: number) => {
    setContentWidthPx(widthPx)
  }, [])

  const filterMode = shouldFilter === false ? "external" : "local"

  const listerItems = useMemo<ListerNode<T>[]>(
    () =>
      items.map(it => ({
        id: it.key,
        searchText: it.value,
        data: it.data,
      })),
    [items],
  )

  const fitStyle = useMemo((): CSSProperties | undefined => {
    if (!fitContent || contentWidthPx <= 0) return undefined
    const minPx = readPaletteSizeMinWidthPx(size)
    const viewportCap =
      typeof window !== "undefined" ? Math.max(minPx, window.innerWidth - 32) : minPx
    const widthPx = Math.min(Math.max(contentWidthPx, minPx), viewportCap)
    return {
      width: widthPx,
      maxWidth: "calc(100% - 2rem)",
    }
  }, [fitContent, contentWidthPx, size])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogHeader className="sr-only">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <DialogContent
        ref={contentRef}
        motion="instant"
        placement="quick-input"
        size={size}
        data-yaade-palette=""
        data-yaade-palette-surface={surface}
        data-yaade-quick-input=""
        data-yaade-palette-fit={fitContent ? "content" : undefined}
        style={fitStyle}
        onOpenAutoFocus={event => {
          event.preventDefault()
          contentRef.current
            ?.querySelector<HTMLInputElement>('[data-slot="command-input"]')
            ?.focus()
        }}
        className={[
          "max-h-[calc(100dvh-var(--yaade-quick-input-top)-1rem)] gap-0 overflow-hidden rounded-md border-border bg-popover p-0 text-popover-foreground shadow-xl",
          contentClassName,
        ]
          .filter(Boolean)
          .join(" ")}
        showCloseButton={false}
      >
        <div className={cn(COMMAND_SHELL_CLASS, "flex min-h-0 flex-col")}>
          <div
            className={cn(
              "flex min-h-0",
              sidecar
                ? "overflow-hidden divide-x divide-border/70"
                : "flex-col",
            )}
          >
            <div className={cn("min-h-0", sidecar ? "min-w-0 flex-1" : "flex-1")}>
              <Lister
                listId="yaade:palette"
                mode="flat"
                flatVariant="palette"
                showInput
                placeholder={placeholder}
                inputDisabled={disabled}
                query={query}
                onQueryChange={setQuery}
                filter={filterMode}
                requireQueryForSelection={requireQueryForSelection}
                aria-label={title}
                items={listerItems}
                itemClassName={cn("mx-0 rounded-none px-2.5 py-0", itemClassName)}
                itemDisabled={node => isItemDisabled?.(node.data) ?? false}
                itemStyle={node => itemStyle?.(node.data)}
                estimateSize={node =>
                  estimateSize?.(node.data) ?? readPaletteRowHeight(rowLayout)
                }
                contentWidthMono={contentWidthMono}
                contentWidthChromePx={fitContent ? contentWidthChromePx : 0}
                onContentWidthChange={
                  fitContent ? onContentWidthChange : undefined
                }
                betweenInputAndList={statusRow}
                listClassName="min-h-0 max-h-[min(var(--yaade-overlay-list-max),calc(100dvh-var(--yaade-quick-input-top)-4rem))] px-1.5 pt-0.5 pb-1.5"
                className="min-h-0"
                emptyState={
                  <div
                    data-slot="command-empty"
                    className="py-6 text-center text-sm text-muted-foreground"
                  >
                    {emptyLabel}
                  </div>
                }
                onActivate={node => {
                  if (isItemDisabled?.(node.data)) return
                  onOpenChange(false)
                  onSelect(node.data, query)
                }}
                onSelectionChange={node =>
                  onHighlightChange?.(node?.data ?? null)
                }
                render={(node, ctx) => renderItem(node.data, ctx.query)}
              />
            </div>
            {sidecar}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
