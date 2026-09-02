import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react"
import { ChevronRight, SearchIcon } from "lucide-react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { yaadeInteractiveRowClass } from "@/motion/tokens.js"
import { registerListPanel, registerListPanelController, type ListPanelController } from "@/lib/list-registry.js"
import { cn } from "@/lib/utils.js"
import { fuzzyFilter } from "./fuzzy.js"
import { filterTreeRows } from "./filter-tree.js"
import {
  measureLongestItemContentWidth,
  readFlatRowHeight,
  readTreeRowHeights,
} from "./measure.js"
import { ListerTreeState, type FlatEntry } from "./tree-state.js"
import type {
  ListerItemContext,
  ListerNode,
  ListerProps,
} from "./types.js"

const OVERSCAN = 8
const DEFAULT_INDENT_PX = 12

function ListerSearchInput({
  value,
  onChange,
  placeholder,
  disabled,
  inputRef,
  autoFocus,
  ariaLabel,
  controlsId,
  activeDescendantId,
  variant,
}: {
  value: string
  onChange: (next: string) => void
  placeholder?: string
  disabled?: boolean
  inputRef?: RefObject<HTMLInputElement | null>
  autoFocus?: boolean
  ariaLabel?: string
  controlsId: string
  activeDescendantId?: string
  variant: "plain" | "quick-input"
}) {
  const setRefs = (el: HTMLInputElement | null) => {
    if (inputRef) (inputRef as MutableRefObject<HTMLInputElement | null>).current = el
  }

  return (
    <div
      data-slot="command-input-wrapper"
      data-yaade-quick-input-field={variant === "quick-input" ? "" : undefined}
      className={cn(
        "flex items-center gap-2",
        variant === "quick-input"
          ? "mx-1.5 mt-1.5 mb-1 h-8 rounded-sm border border-input bg-background px-2 shadow-xs focus-within:border-primary focus-within:ring-1 focus-within:ring-primary"
          : "h-9 border-b px-3",
      )}
    >
      <SearchIcon
        className={cn(
          "shrink-0 opacity-50",
          variant === "quick-input" ? "size-3.5" : "size-4",
        )}
        aria-hidden="true"
      />
      <input
        ref={setRefs}
        data-slot="command-input"
        role="combobox"
        aria-expanded={true}
        aria-autocomplete="list"
        aria-label={ariaLabel ?? placeholder ?? "Filter items"}
        aria-controls={controlsId}
        aria-activedescendant={activeDescendantId}
        autoFocus={autoFocus}
        className={cn(
          "flex w-full min-w-0 flex-1 bg-transparent text-sm outline-none focus-visible:ring-0 placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
          variant === "quick-input" ? "h-full rounded-none py-0" : "h-10 rounded-md py-3",
        )}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={e => onChange(e.target.value)}
      />
    </div>
  )
}

function TreeRowChrome<T>({
  entry,
  ctx,
  rowHeight,
  indentPx,
  rowAriaLabel,
  rowId,
  onClick,
  render,
  rowActions,
  query,
}: {
  entry: FlatEntry<T>
  ctx: ListerItemContext
  rowHeight: number
  indentPx: number
  rowAriaLabel?: string
  rowId?: string
  onClick: () => void
  render: (node: ListerNode<T>, ctx: ListerItemContext) => ReactNode
  rowActions?: (node: ListerNode<T>) => ReactNode
  query: string
}) {
  const paddingLeft = 4 + ctx.depth * indentPx
  return (
    <div
      data-active={ctx.selected || ctx.active ? "true" : undefined}
      className={cn(
        "group/tree-row h-[var(--yaade-row-height)] w-full shrink-0 cursor-pointer gap-1 rounded-sm px-2",
        yaadeInteractiveRowClass,
        ctx.selected && "bg-sidebar-accent text-sidebar-accent-foreground",
      )}
      style={{
        height: rowHeight,
        paddingLeft,
      }}
    >
      <div
        id={rowId}
        role="treeitem"
        aria-label={rowAriaLabel}
        aria-level={ctx.depth + 1}
        aria-expanded={ctx.isBranch ? ctx.expanded : undefined}
        data-yaade-list-item
        data-depth={ctx.depth}
        data-node-id={entry.node.id}
        onClick={event => {
          if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return
          onClick()
        }}
        onMouseDown={event => {
          // While search input focused, keep the click on the row (expand/activate).
          if (event.button === 0) event.preventDefault()
        }}
        className="flex h-full w-full min-w-0 items-center gap-1"
      >
        {ctx.isBranch ? (
          <ChevronRight
            className={cn(
              "size-3 shrink-0 transition-transform duration-[var(--yaade-motion-fast)]",
              ctx.expanded && "rotate-90",
            )}
          />
        ) : (
          <span className="size-3 shrink-0" />
        )}
        {render(entry.node, { ...ctx, query })}
        {ctx.loading ? <span className="ml-auto text-muted-foreground/60">…</span> : null}
        {rowActions ? (
          <span className="ml-auto flex shrink-0 items-center">{rowActions(entry.node)}</span>
        ) : null}
      </div>
    </div>
  )
}

export function Lister<T>({
  listId,
  mode,
  items,
  source,
  render,
  showInput = false,
  autoFocusInput,
  placeholder,
  query: queryProp,
  onQueryChange,
  filter = "local",
  onActivate,
  onSelectionChange,
  emptyState,
  initiallyExpanded,
  onExpandedChange,
  syncExpanded = false,
  activeId,
  indentPx = DEFAULT_INDENT_PX,
  rowActions,
  wrapRow,
  rowAriaLabel,
  estimateSize,
  requireQueryForSelection = false,
  flatVariant = "plain",
  itemClassName,
  itemDisabled,
  itemStyle,
  className,
  listClassName,
  inputDisabled,
  betweenInputAndList,
  contentWidthLabel,
  contentWidthChromePx = 0,
  contentWidthMono = false,
  onContentWidthChange,
  "aria-label": ariaLabel,
  role,
}: ListerProps<T>) {
  const isControlled = queryProp !== undefined
  const [uncontrolledQuery, setUncontrolledQuery] = useState("")
  const query = isControlled ? queryProp : uncontrolledQuery
  const setQuery = useCallback(
    (next: string) => {
      if (!isControlled) setUncontrolledQuery(next)
      onQueryChange?.(next)
    },
    [isControlled, onQueryChange],
  )

  const [selectedIndex, setSelectedIndex] = useState(
    requireQueryForSelection ? -1 : 0,
  )

  // --- tree state ---
  const stateRef = useRef<ListerTreeState<T> | null>(null)
  if (mode === "tree" && source && stateRef.current === null) {
    stateRef.current = new ListerTreeState(source, initiallyExpanded ?? [])
  }
  const treeState = stateRef.current
  const lastSourceRef = useRef(source)
  if (mode === "tree" && treeState && source && lastSourceRef.current !== source) {
    treeState.setSource(source)
    treeState.reloadExpanded()
    lastSourceRef.current = source
  }

  const [treeRev, setTreeRev] = useState(0)
  const previousQueryRef = useRef(query)
  useEffect(() => {
    if (!treeState) return
    return treeState.subscribe(() => setTreeRev(r => r + 1))
  }, [treeState])

  useEffect(() => {
    if (!source?.subscribe || !treeState) return
    return source.subscribe(() => {
      treeState.reloadExpanded()
    })
  }, [source, treeState, initiallyExpanded])

  useEffect(() => {
    if (!treeState) return
    if (syncExpanded) treeState.setExpanded(initiallyExpanded ?? [])
    for (const id of initiallyExpanded ?? []) void treeState.ensureChildren(id)
  }, [initiallyExpanded, syncExpanded, treeState])

  const treeRows: FlatEntry<T>[] = useMemo(() => {
    void treeRev
    if (!treeState) return []
    return treeState.flatten()
  }, [treeRev, treeState])

  // --- visible rows ---
  type VisibleRow = {
    node: ListerNode<T>
    depth: number
    expanded: boolean
    loading: boolean
  }

  const visibleRows: VisibleRow[] = useMemo(() => {
    if (mode === "tree") {
      const rows = treeRows.map(e => ({
        node: e.node,
        depth: e.depth,
        expanded: e.expanded,
        loading: e.loading,
        searchText: e.node.searchText,
        isBranch: Boolean(e.node.isBranch),
      }))
      if (filter !== "local" || !query.trim()) {
        return rows.map(({ node, depth, expanded, loading }) => ({
          node,
          depth,
          expanded,
          loading,
        }))
      }
      return filterTreeRows(query, rows).map(({ node, depth, expanded, loading }) => ({
        node,
        depth,
        expanded,
        loading,
      }))
    }
    const flat = items ?? []
    if (filter === "local" && query.trim()) {
      return fuzzyFilter(query, flat).map(node => ({
        node,
        depth: 0,
        expanded: false,
        loading: false,
      }))
    }
    return flat.map(node => ({
      node,
      depth: 0,
      expanded: false,
      loading: false,
    }))
  }, [mode, treeRows, items, filter, query])

  const selectedNode =
    selectedIndex >= 0 ? (visibleRows[selectedIndex]?.node ?? null) : null
  useEffect(() => {
    onSelectionChange?.(selectedNode)
  }, [onSelectionChange, selectedNode])

  const lastContentWidthRef = useRef<number | null>(null)
  useLayoutEffect(() => {
    if (!onContentWidthChange) return

    const report = () => {
      const labels = visibleRows.map(
        row => contentWidthLabel?.(row.node) ?? row.node.searchText,
      )
      const widthPx = measureLongestItemContentWidth(labels, {
        mono: contentWidthMono,
        chromePx: contentWidthChromePx,
      })
      if (lastContentWidthRef.current === widthPx) return
      lastContentWidthRef.current = widthPx
      onContentWidthChange(widthPx)
    }

    report()
    let cancelled = false
    if (typeof document !== "undefined" && document.fonts?.ready) {
      void document.fonts.ready.then(() => {
        if (!cancelled) report()
      })
    }
    return () => {
      cancelled = true
    }
  }, [
    visibleRows,
    contentWidthLabel,
    contentWidthChromePx,
    contentWidthMono,
    onContentWidthChange,
  ])

  useEffect(() => {
    const queryChanged = previousQueryRef.current !== query
    previousQueryRef.current = query
    if (queryChanged) {
      setSelectedIndex(
        visibleRows.length === 0 || (requireQueryForSelection && query.trim() === "")
          ? -1
          : 0,
      )
      return
    }
    if (requireQueryForSelection && query.trim() === "") {
      setSelectedIndex(-1)
      return
    }
    if (visibleRows.length === 0) {
      setSelectedIndex(-1)
      return
    }
    setSelectedIndex(i => {
      if (i < 0) return requireQueryForSelection && query.trim() === "" ? -1 : 0
      if (i >= visibleRows.length) return visibleRows.length - 1
      return i
    })
  }, [visibleRows, query, requireQueryForSelection])

  const scrollRef = useRef<HTMLElement | null>(null)
  const [treeHeights, setTreeHeights] = useState(readTreeRowHeights)
  const [flatHeight, setFlatHeight] = useState(readFlatRowHeight)

  useLayoutEffect(() => {
    const measure = () => {
      setTreeHeights(readTreeRowHeights())
      setFlatHeight(readFlatRowHeight())
    }
    measure()
    const raf = requestAnimationFrame(measure)
    let cancelled = false
    if (typeof document !== "undefined" && document.fonts?.ready) {
      document.fonts.ready.then(() => {
        if (!cancelled) measure()
      })
    }
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
    }
  }, [])

  useEffect(
    () => registerListPanel(listId, scrollRef.current),
    [listId, visibleRows.length],
  )

  const selectedIndexRef = useRef(selectedIndex)
  selectedIndexRef.current = selectedIndex
  const visibleCountRef = useRef(visibleRows.length)
  visibleCountRef.current = visibleRows.length
  const activateIndexRef = useRef<(index: number) => void>(() => {})

  const moveSelection = useCallback((delta: number) => {
    setSelectedIndex(i => {
      const count = visibleCountRef.current
      if (count <= 0) return -1
      if (i < 0) return delta > 0 ? 0 : count - 1
      return Math.max(0, Math.min(count - 1, i + delta))
    })
    scrollRef.current?.focus()
  }, [])

  const virtualizer = useVirtualizer({
    count: visibleRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: index => {
      const row = visibleRows[index]
      if (!row) return flatHeight
      if (estimateSize) return estimateSize(row.node, row.depth)
      if (mode === "tree") {
        return row.depth === 0 ? treeHeights.root : treeHeights.child
      }
      return flatHeight
    },
    overscan: OVERSCAN,
  })

  useEffect(() => {
    if (selectedIndex < 0) return
    virtualizer.scrollToIndex(selectedIndex, { align: "auto" })
  }, [selectedIndex, virtualizer])

  const activateIndex = useCallback(
    (index: number) => {
      const row = visibleRows[index]
      if (!row || itemDisabled?.(row.node)) return
      if (mode === "tree" && row.node.isBranch && treeState) {
        void treeState.toggle(row.node.id).then(() => {
          onExpandedChange?.(treeState.expandedIds())
        })
      }
      onActivate(row.node)
    },
    [visibleRows, mode, treeState, onActivate, onExpandedChange, itemDisabled],
  )
  activateIndexRef.current = activateIndex

  useEffect(() => {
    const page = () => {
      const el = scrollRef.current
      if (!el) return 8
      const row = mode === "tree" ? treeHeights.child : flatHeight
      return Math.max(1, Math.floor(el.clientHeight / Math.max(1, row)) - 1)
    }
    const controller: ListPanelController = {
      focusNext: () => moveSelection(1),
      focusPrev: () => moveSelection(-1),
      activate: () => {
        const i = selectedIndexRef.current
        if (i >= 0) activateIndexRef.current(i)
      },
      focusFirstItem: () => {
        setSelectedIndex(visibleCountRef.current > 0 ? 0 : -1)
        scrollRef.current?.focus()
      },
      focusLastItem: () => {
        setSelectedIndex(visibleCountRef.current > 0 ? visibleCountRef.current - 1 : -1)
        scrollRef.current?.focus()
      },
      focusPageUp: () => moveSelection(-page()),
      focusPageDown: () => moveSelection(page()),
      focusFirst: () => {
        if (scrollRef.current) scrollRef.current.scrollTop = 0
      },
      focusLast: () => {
        const el = scrollRef.current
        if (el) el.scrollTop = el.scrollHeight
      },
    }
    return registerListPanelController(listId, controller)
  }, [listId, moveSelection, mode, treeHeights.child, flatHeight])

  const rootRef = useRef<HTMLDivElement | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)

  /** showInput = initial only; any non-empty query reveals the field. */
  const inputVisible = showInput || query.length > 0
  const prevInputVisible = useRef(inputVisible)

  useLayoutEffect(() => {
    const wasVisible = prevInputVisible.current
    const becameVisible = inputVisible && !wasVisible
    const becameHidden = !inputVisible && wasVisible
    prevInputVisible.current = inputVisible

    if (showInput) return

    if (becameVisible) {
      searchInputRef.current?.focus()
      return
    }
    // Input unmounted after Esc / delete-all — put focus back on list for re-type.
    if (becameHidden) {
      scrollRef.current?.focus()
    }
  }, [inputVisible, showInput])

  // Keyboard: when search field visible (palette or typed query), arrows/enter local
  // (global keymap ignores keys while focus is in <input>). Panel w/o search: App list.*.
  useEffect(() => {
    const root = rootRef.current
    if (!root) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (!root.contains(document.activeElement) && document.activeElement !== root) {
        return
      }

      const active = document.activeElement
      const inSearchInput =
        active instanceof HTMLElement && active.getAttribute("data-slot") === "command-input"
      const inForeignInput =
        (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) &&
        !inSearchInput
      const inForeignControl =
        active instanceof HTMLElement &&
        active.closest("button, [role=button]") !== null &&
        !active.hasAttribute("data-yaade-list-item")
      if (inForeignInput || inForeignControl) return

      const searchFieldOpen = showInput || query.length > 0

      if (event.key === "ArrowDown") {
        if (!searchFieldOpen) return
        event.preventDefault()
        event.stopPropagation()
        if (requireQueryForSelection && query.trim() === "") return
        setSelectedIndex(i => Math.min(visibleRows.length - 1, Math.max(0, i) + 1))
        return
      }
      if (event.key === "ArrowUp") {
        if (!searchFieldOpen) return
        event.preventDefault()
        event.stopPropagation()
        if (requireQueryForSelection && query.trim() === "") return
        setSelectedIndex(i => Math.max(0, (i < 0 ? 0 : i) - 1))
        return
      }
      if (event.key === "Home" || event.key === "End") {
        if (!searchFieldOpen || visibleRows.length === 0) return
        event.preventDefault()
        event.stopPropagation()
        setSelectedIndex(event.key === "Home" ? 0 : visibleRows.length - 1)
        return
      }
      if (event.key === "Enter") {
        if (!searchFieldOpen) return
        if (selectedIndex >= 0) {
          event.preventDefault()
          event.stopPropagation()
          activateIndex(selectedIndex)
        }
        return
      }

      if (event.key === "Escape") {
        if (query) {
          event.preventDefault()
          event.stopPropagation()
          setQuery("")
        }
        return
      }

      // Search input owns printable / backspace once visible + focused
      if (inSearchInput) return

      if (event.key === "Backspace") {
        if (!query) return
        event.preventDefault()
        setQuery(query.slice(0, -1))
        return
      }
      if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault()
        setQuery(query + event.key)
      }
    }

    // Capture so arrows work while caret is in the search field (before input handles them).
    root.addEventListener("keydown", onKeyDown, true)
    return () => root.removeEventListener("keydown", onKeyDown, true)
  }, [
    showInput,
    query,
    setQuery,
    visibleRows.length,
    selectedIndex,
    activateIndex,
    requireQueryForSelection,
  ])

  const listRole = role ?? (mode === "tree" ? "tree" : "listbox")
  const listElementId = `${listId}-options`
  const optionId = (nodeId: string) =>
    `${listId}-option-${encodeURIComponent(nodeId)}`

  const body =
    visibleRows.length === 0 ? (
      emptyState ?? null
    ) : (
      <div
        style={{
          height: virtualizer.getTotalSize(),
          width: "100%",
          position: "relative",
        }}
      >
        {virtualizer.getVirtualItems().map(v => {
          const entry = visibleRows[v.index]!
          const selected = v.index === selectedIndex
          const ctx: ListerItemContext = {
            depth: entry.depth,
            expanded: entry.expanded,
            loading: entry.loading,
            isBranch: Boolean(entry.node.isBranch),
            active: activeId != null && activeId === entry.node.id,
            selected,
            query,
          }

          if (mode === "tree") {
            const flatEntry: FlatEntry<T> = {
              node: entry.node,
              depth: entry.depth,
              expanded: entry.expanded,
              loading: entry.loading,
            }
            const rowHeight =
              estimateSize?.(entry.node, entry.depth) ??
              (entry.depth === 0 ? treeHeights.root : treeHeights.child)
            const row = (
              <TreeRowChrome
                entry={flatEntry}
                ctx={ctx}
                rowHeight={rowHeight}
                indentPx={indentPx}
                rowAriaLabel={rowAriaLabel?.(entry.node)}
                rowId={optionId(entry.node.id)}
                onClick={() => {
                  setSelectedIndex(v.index)
                  activateIndex(v.index)
                }}
                render={render}
                rowActions={rowActions}
                query={query}
              />
            )
            // Absolute slot MUST own translateY — wrapRow (ContextMenu) must not
            // sit between the positioned layer and the virtualizer container.
            return (
              <div
                key={`${v.index}:${entry.node.id}`}
                data-yaade-tree-row-slot
                className="absolute left-0 top-0 w-full shrink-0"
                style={{
                  transform: `translateY(${v.start}px)`,
                  height: rowHeight,
                }}
              >
                {wrapRow ? wrapRow(entry.node, row) : row}
              </div>
            )
          }

          const rowHeight = estimateSize?.(entry.node, 0) ?? flatHeight
          const disabled = itemDisabled?.(entry.node) ?? false
          const posStyle = {
            transform: `translateY(${v.start}px)`,
            height: rowHeight,
            ...itemStyle?.(entry.node),
          } as const

          const flatRow =
            flatVariant === "palette" ? (
              <button
                id={optionId(entry.node.id)}
                type="button"
                role="option"
                aria-selected={selected}
                aria-disabled={disabled || undefined}
                data-disabled={disabled ? "true" : undefined}
                data-yaade-list-item
                data-yaade-list-index={v.index}
                data-node-id={entry.node.id}
                data-slot="command-item"
                data-selected={selected ? "true" : undefined}
                className={cn(
                  "absolute left-0 top-0 flex w-full shrink-0 cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none select-none aria-disabled:cursor-not-allowed aria-disabled:opacity-55",
                  selected && "bg-accent text-accent-foreground",
                  itemClassName,
                )}
                style={posStyle}
                onMouseDown={event => {
                  if (event.button === 0) event.preventDefault()
                }}
                onClick={() => {
                  setSelectedIndex(v.index)
                  activateIndex(v.index)
                }}
                onKeyDown={event => {
                  if (event.key !== "Enter" && event.key !== " ") return
                  event.preventDefault()
                  event.stopPropagation()
                  setSelectedIndex(v.index)
                  activateIndex(v.index)
                }}
                onMouseEnter={() => {
                  if (requireQueryForSelection && query.trim() === "") return
                  setSelectedIndex(v.index)
                }}
                onFocus={() => {
                  if (requireQueryForSelection && query.trim() === "") return
                  setSelectedIndex(v.index)
                }}
              >
                {render(entry.node, ctx)}
              </button>
            ) : (
              <div
                className="absolute left-0 top-0 w-full"
                style={posStyle}
                onMouseEnter={() => setSelectedIndex(v.index)}
              >
                {render(entry.node, ctx)}
              </div>
            )
          return (
            <div key={`${v.index}:${entry.node.id}`} className="contents">
              {wrapRow ? wrapRow(entry.node, flatRow as ReactElement) : flatRow}
            </div>
          )
        })}
      </div>
    )

  const scrollEl =
    mode === "tree" ? (
      <div
        id={listElementId}
        ref={el => {
          scrollRef.current = el
        }}
        className={cn("min-h-0 flex-1 gap-0 overflow-auto", listClassName)}
        data-yaade-list-panel={listId}
        tabIndex={-1}
        role={listRole}
        aria-label={ariaLabel}
      >
        {body}
      </div>
    ) : (
      <div
        id={listElementId}
        ref={el => {
          scrollRef.current = el
        }}
        className={cn("min-h-0 flex-1 overflow-auto", listClassName)}
        data-yaade-list-panel={listId}
        tabIndex={-1}
        role={listRole}
        aria-label={ariaLabel}
      >
        {body}
      </div>
    )

  return (
    <div
      ref={rootRef}
      className={cn("flex h-full min-h-0 flex-col", className)}
      data-yaade-lister
      data-yaade-lister-mode={mode}
      onPointerDown={() => {
        scrollRef.current?.focus()
      }}
    >
      {inputVisible ? (
        <ListerSearchInput
          value={query}
          onChange={setQuery}
          placeholder={placeholder}
          disabled={inputDisabled}
          inputRef={searchInputRef}
          autoFocus={autoFocusInput ?? (showInput || query.length > 0)}
          ariaLabel={ariaLabel}
          controlsId={listElementId}
          activeDescendantId={
            selectedIndex >= 0
              ? optionId(visibleRows[selectedIndex]?.node.id ?? "")
              : undefined
          }
          variant={flatVariant === "palette" ? "quick-input" : "plain"}
        />
      ) : null}
      {betweenInputAndList}
      {scrollEl}
    </div>
  )
}
