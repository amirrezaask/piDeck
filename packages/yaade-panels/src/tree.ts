import {
  type Edge,
  type PanelId,
  panelId,
} from "@yaade/shared"

const SPLITTER = 4

export type Rect = { x: number; y: number; width: number; height: number }

export type PanelSplit<TView> = {
  children: PanelNode<TView>[]
  ratios: number[]
}

export type PanelNode<TView> =
  | { kind: "leaf"; panelId: PanelId; view: TView }
  | { kind: "row"; split: PanelSplit<TView> }
  | { kind: "column"; split: PanelSplit<TView> }

export type PanelTreeSnapshot<TView> = {
  root: PanelNode<TView>
  nextPanelId: number
}

export type PanelTreeOptions<TView> = {
  /** Factory for the view placed in freshly created leaves (splits, initial root, close-fallback). */
  emptyView: () => TView
  /** Predicate identifying empty views for {@link PanelTree.pruneEmptyLeaves}. */
  isEmpty: (view: TView) => boolean
}

export class PanelTree<TView> {
  root: PanelNode<TView>
  private nextPanelId = 1
  private readonly options: PanelTreeOptions<TView>

  constructor(options: PanelTreeOptions<TView>, root?: PanelNode<TView>) {
    this.options = options
    this.root =
      root ??
      ({
        kind: "leaf",
        panelId: panelId(1),
        view: options.emptyView(),
      } satisfies PanelNode<TView>)
    if (!root) this.nextPanelId = 2
  }

  allocPanelId(): PanelId {
    return panelId(this.nextPanelId++)
  }

  setView(panel: PanelId, view: TView): void {
    this.visitLeaves(node => {
      if (node.panelId.id !== panel.id) return
      node.view = view
    })
  }

  getView(panel: PanelId): TView | null {
    const leaf = this.getLeaf(panel)
    return leaf?.view ?? null
  }

  findPanelWithView(predicate: (view: TView) => boolean): PanelId | null {
    let found: PanelId | null = null
    this.visitLeaves(node => {
      if (found) return
      if (predicate(node.view)) found = node.panelId
    })
    return found
  }

  splitAtEdge(panel: PanelId, edge: Edge): PanelId {
    const newPanelId = this.allocPanelId()
    const newLeaf: PanelNode<TView> = {
      kind: "leaf",
      panelId: newPanelId,
      view: this.options.emptyView(),
    }

    const replace = (node: PanelNode<TView>): PanelNode<TView> => {
      if (node.kind !== "leaf" || node.panelId.id !== panel.id) return node

      const horizontal = edge === "left" || edge === "right"
      const kind = horizontal ? "row" : "column"
      const first = edge === "right" || edge === "bottom" ? node : newLeaf
      const second = edge === "right" || edge === "bottom" ? newLeaf : node

      return {
        kind,
        split: {
          children: [first, second],
          ratios: [0.5, 0.5],
        },
      } satisfies PanelNode<TView>
    }

    this.root = this.mapNode(this.root, replace)
    return newPanelId
  }

  closePanel(panel: PanelId): void {
    this.root = this.removePanel(this.root, panel) ?? this.createDefaultLeaf()
  }

  computeRects(viewport: Rect): Map<number, Rect> {
    const map = new Map<number, Rect>()
    this.layoutNode(this.root, viewport, map)
    return map
  }

  setSplitRatios(path: number[], ratios: number[]): boolean {
    const node = this.getAtPath(this.root, path)
    if (!node || node.kind === "leaf") return false
    if (ratios.length !== node.split.children.length) return false
    if (ratios.some(ratio => !Number.isFinite(ratio) || ratio <= 0)) return false
    const next = [...ratios]
    if (!this.normalizeRatios(next)) return false
    const changed = next.some((ratio, index) => Math.abs(ratio - node.split.ratios[index]!) > 0.001)
    if (!changed) return false
    node.split.ratios = next
    return true
  }

  attachAtViewportEdge(edge: Edge): PanelId {
    const newPanelId = this.allocPanelId()
    const newLeaf: PanelNode<TView> = {
      kind: "leaf",
      panelId: newPanelId,
      view: this.options.emptyView(),
    }
    const kind = edge === "left" || edge === "right" ? "row" : "column"
    const first = edge === "right" || edge === "bottom" ? this.root : newLeaf
    const second = edge === "right" || edge === "bottom" ? newLeaf : this.root
    this.root = {
      kind,
      split: { children: [first, second], ratios: edge === "left" || edge === "top" ? [0.22, 0.78] : [0.78, 0.22] },
    }
    return newPanelId
  }

  /** Remove empty leaves when more than one leaf exists. */
  pruneEmptyLeaves(): void {
    for (let guard = 0; guard < 64; guard++) {
      let leafCount = 0
      const empty: PanelId[] = []
      this.visitLeaves(node => {
        leafCount++
        if (this.options.isEmpty(node.view)) empty.push(node.panelId)
      })
      if (empty.length === 0 || leafCount <= 1) break
      for (const panel of empty) this.closePanel(panel)
    }
  }

  getLeaf(panel: PanelId): { panelId: PanelId; view: TView } | null {
    let leaf: { panelId: PanelId; view: TView } | null = null
    this.visitLeaves(node => {
      if (node.panelId.id === panel.id) leaf = node
    })
    return leaf
  }

  visitLeaves(fn: (node: Extract<PanelNode<TView>, { kind: "leaf" }>) => void): void {
    const walk = (node: PanelNode<TView>) => {
      if (node.kind === "leaf") fn(node)
      else node.split.children.forEach(walk)
    }
    walk(this.root)
  }

  /** Shallow structural clone — shares leaf views until mutated on the copy. */
  clone(): PanelTree<TView> {
    return this.cloneInto(new PanelTree(this.options))
  }

  /** Preserve runtime subclass identity while copying the tree's mutable structure. */
  protected cloneInto<TTree extends PanelTree<TView>>(tree: TTree): TTree {
    tree.root = clonePanelNode(this.root)
    tree.nextPanelId = this.nextPanelId
    return tree
  }

  toJSON(): PanelTreeSnapshot<TView> {
    return {
      root: structuredClone(this.root),
      nextPanelId: this.nextPanelId,
    }
  }

  applySnapshot(snapshot: PanelTreeSnapshot<TView>): void {
    this.root = snapshot.root
    const minimumNextId = maxPanelId(snapshot.root) + 1
    this.nextPanelId = Number.isSafeInteger(snapshot.nextPanelId) && snapshot.nextPanelId > 0
      ? Math.max(snapshot.nextPanelId, minimumNextId)
      : minimumNextId
  }

  static fromSnapshot<TView>(
    options: PanelTreeOptions<TView>,
    snapshot: PanelTreeSnapshot<TView>,
  ): PanelTree<TView> {
    const tree = new PanelTree(options)
    tree.applySnapshot(snapshot)
    return tree
  }

  static fromJSON<TView>(
    options: PanelTreeOptions<TView>,
    snapshot: PanelTreeSnapshot<TView>,
  ): PanelTree<TView> {
    return PanelTree.fromSnapshot(options, snapshot)
  }

  /** Toggle root split between row and column; no-op when root is a leaf. */
  toggleRootOrientation(): boolean {
    if (this.root.kind !== "row" && this.root.kind !== "column") return false
    this.root = {
      kind: this.root.kind === "row" ? "column" : "row",
      split: this.root.split,
    }
    return true
  }

  private createDefaultLeaf(): PanelNode<TView> {
    const id = this.allocPanelId()
    return { kind: "leaf", panelId: id, view: this.options.emptyView() }
  }

  private mapNode(
    node: PanelNode<TView>,
    replace: (node: PanelNode<TView>) => PanelNode<TView>,
  ): PanelNode<TView> {
    const replaced = replace(node)
    if (replaced !== node) return replaced
    if (replaced.kind === "leaf") return replaced
    return {
      ...replaced,
      split: {
        ...replaced.split,
        children: replaced.split.children.map(c => this.mapNode(c, replace)),
      },
    }
  }

  private removePanel(node: PanelNode<TView>, panel: PanelId): PanelNode<TView> | null {
    if (node.kind === "leaf") {
      return node.panelId.id === panel.id ? null : node
    }
    const children = node.split.children
      .map(c => this.removePanel(c, panel))
      .filter((c): c is PanelNode<TView> => c != null)
    if (children.length === 0) return null
    if (children.length === 1) return children[0]!
    return {
      kind: node.kind,
      split: { children, ratios: this.rebalanceRatios(children.length) },
    }
  }

  private rebalanceRatios(n: number): number[] {
    return Array.from({ length: n }, () => 1 / n)
  }

  private normalizeRatios(ratios: number[]): boolean {
    const sum = ratios.reduce((a, b) => a + b, 0)
    if (!Number.isFinite(sum) || sum <= 0) return false
    for (let i = 0; i < ratios.length; i++) ratios[i]! /= sum
    return true
  }

  private layoutNode(node: PanelNode<TView>, rect: Rect, map: Map<number, Rect>): void {
    if (node.kind === "leaf") {
      map.set(node.panelId.id, rect)
      return
    }
    const { children, ratios } = node.split
    const horizontal = node.kind === "row"
    let offset = horizontal ? rect.x : rect.y
    const total = horizontal ? rect.width : rect.height
    const available = total - SPLITTER * (children.length - 1)

    children.forEach((child, i) => {
      const size = available * ratios[i]!
      const childRect: Rect = horizontal
        ? { x: offset, y: rect.y, width: size, height: rect.height }
        : { x: rect.x, y: offset, width: rect.width, height: size }
      this.layoutNode(child, childRect, map)
      offset += size + SPLITTER
    })
  }

  private getAtPath(node: PanelNode<TView>, path: number[]): PanelNode<TView> | null {
    let current: PanelNode<TView> = node
    for (const idx of path) {
      if (current.kind === "leaf") return null
      current = current.split.children[idx]!
      if (!current) return null
    }
    return current
  }
}

function maxPanelId<TView>(node: PanelNode<TView>): number {
  if (node.kind === "leaf") return node.panelId.id
  return node.split.children.reduce(
    (maximum, child) => Math.max(maximum, maxPanelId(child)),
    0,
  )
}

function clonePanelNode<TView>(node: PanelNode<TView>): PanelNode<TView> {
  if (node.kind === "leaf") {
    return { kind: "leaf", panelId: node.panelId, view: node.view }
  }
  return {
    kind: node.kind,
    split: {
      children: node.split.children.map(clonePanelNode),
      ratios: [...node.split.ratios],
    },
  }
}

export { clonePanelNode }
export * from "./events.js"
