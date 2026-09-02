import type { ListerDataSource, ListerNode, ListerNodeId } from "./types.js"

export type FlatEntry<T> = {
  node: ListerNode<T>
  depth: number
  expanded: boolean
  loading: boolean
}

export class ListerTreeState<T> {
  private source: ListerDataSource<T>
  private readonly childCache = new Map<ListerNodeId, ListerNode<T>[]>()
  private readonly loading = new Map<ListerNodeId, number>()
  private readonly expanded: Set<ListerNodeId>
  private readonly listeners = new Set<() => void>()
  private generation = 0

  constructor(source: ListerDataSource<T>, initiallyExpanded: ListerNodeId[]) {
    this.source = source
    this.expanded = new Set(initiallyExpanded)
  }

  setSource(next: ListerDataSource<T>): void {
    this.source = next
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  private notify(): void {
    for (const l of this.listeners) l()
  }

  async ensureChildren(id: ListerNodeId): Promise<void> {
    const generation = this.generation
    if (this.childCache.has(id) || this.loading.get(id) === generation) return
    const result = this.source.getChildren(id)
    if (result === null) return
    if (Array.isArray(result)) {
      this.childCache.set(id, result)
      this.notify()
      return
    }
    this.loading.set(id, generation)
    this.notify()
    try {
      const entries = await result
      if (this.generation === generation) this.childCache.set(id, entries)
    } finally {
      if (this.loading.get(id) === generation) {
        this.loading.delete(id)
        this.notify()
      }
    }
  }

  async toggle(id: ListerNodeId): Promise<void> {
    if (this.expanded.has(id)) {
      this.expanded.delete(id)
      this.notify()
      return
    }
    this.expanded.add(id)
    this.notify()
    await this.ensureChildren(id)
  }

  setExpanded(ids: ListerNodeId[]): void {
    this.expanded.clear()
    for (const id of ids) this.expanded.add(id)
    this.notify()
  }

  expandedIds(): ListerNodeId[] {
    return [...this.expanded]
  }

  invalidate(): void {
    this.generation++
    this.childCache.clear()
    this.loading.clear()
    this.notify()
  }

  /** Clear cached rows and repopulate every branch the user left expanded. */
  reloadExpanded(): void {
    this.invalidate()
    for (const id of this.expanded) void this.ensureChildren(id)
  }

  flatten(): FlatEntry<T>[] {
    const rows: FlatEntry<T>[] = []
    const walk = (nodes: ListerNode<T>[], depth: number): void => {
      for (const node of nodes) {
        const expanded = this.expanded.has(node.id)
        rows.push({
          node,
          depth,
          expanded,
          loading: this.loading.has(node.id),
        })
        if (node.isBranch && expanded) {
          const children = this.childCache.get(node.id)
          if (children) walk(children, depth + 1)
        }
      }
    }
    walk(this.source.getRoots(), 0)
    return rows
  }
}
